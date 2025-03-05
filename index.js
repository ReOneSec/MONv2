// index.js
const Web3 = require('web3');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

// Import modules
const { CONFIG, CONTRACT_ABI } = require('./config');
const { logger, logAction } = require('./logger');
const Validator = require('./validation');
const { WalletManager } = require('./wallet');
const TransactionManager = require('./transaction');
const ContractManager = require('./contracts');
const TelegramFormatter = require('./telegram');

// Initialize Web3 and Bot
const web3 = new Web3(CONFIG.RPC_URL);
const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: true });
const app = express();

// Initialize managers
const walletManager = new WalletManager(CONFIG.MASTER_PASSWORD, web3);
const txManager = new TransactionManager(web3);
const contractManager = new ContractManager(web3, CONTRACT_ABI);

// Add default contract if no contracts exist
if (contractManager.getAllContracts().length === 0) {
  try {
    contractManager.addContract(CONFIG.CONTRACT_ADDRESS, 'Default Contract');
    contractManager.activateContract(CONFIG.CONTRACT_ADDRESS);
    logger.info('Default contract initialized', { address: CONFIG.CONTRACT_ADDRESS });
  } catch (error) {
    logger.error('Error initializing default contract:', error);
  }
}

// Helper function to safely send Telegram messages with formatting
async function safeSendMessage(chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (error) {
    logger.error('Error sending formatted message:', { 
      error: error.message, 
      chatId,
      parseMode: options.parse_mode || 'none'
    });
    
    // If the error is related to formatting, try with plain text
    if (error.message.includes('can\'t parse entities') || 
        error.message.includes('Bad Request') || 
        error.message.includes('ETELEGRAM: 400')) {
      
      // Strip all Markdown formatting
      const plainText = text
        .replace(/\*/g, '')
        .replace(/\`/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // Replace links with just the text
        .replace(/\n\n/g, '\n');  // Reduce double newlines
      
      try {
        return await bot.sendMessage(chatId, plainText);
      } catch (fallbackError) {
        logger.error('Even fallback message failed:', fallbackError.message);
        // As a last resort, send a simple error message
        return await bot.sendMessage(chatId, '❌ Error displaying message. Please try again later.');
      }
    }
    
    // For other types of errors, rethrow
    throw error;
  }
}

// ========== CORE MINT FUNCTION ========== //
async function sendMonadMintTx(walletAddress, msg, retryCount = 0) {
  try {
    const wallet = walletManager.getWallet(walletAddress);
    if (!wallet || !wallet.active) {
      throw new Error(`Wallet ${walletAddress} not found or inactive`);
    }
    
    const activeContract = contractManager.getActiveContract();
    if (!activeContract) {
      throw new Error('No active contract configured');
    }
    
    const activeContractAddress = contractManager.getActiveContractAddress();
    
    logAction('mint_attempt', { 
      address: walletAddress, 
      retryCount,
      contractAddress: activeContractAddress
    });
    
    const account = web3.eth.accounts.privateKeyToAccount(wallet.privateKey);
    const nonceData = await txManager.getNonce(account.address);
    
    const tx = {
      from: account.address,
      to: activeContractAddress,
      data: activeContract.methods.mint().encodeABI(), // Fixed: Added 'data:' field name
      gas: CONFIG.GAS_LIMIT,
      gasPrice: CONFIG.GAS_PRICE,
      chainId: CONFIG.CHAIN_ID,
      nonce: nonceData.nonce
    };

    const signedTx = await account.signTransaction(tx);
    
    await safeSendMessage(
      msg.chat.id, 
      `⏳ Processing mint from ${TelegramFormatter.code(account.address.substring(0, 10) + '...')}`, 
      { parse_mode: 'Markdown' }
    );
    
    const receipt = await txManager.sendTransaction(signedTx, account.address, {
      to: activeContractAddress,
      gasPrice: CONFIG.GAS_PRICE,
      gasLimit: CONFIG.GAS_LIMIT,
      timeout: CONFIG.TX_TIMEOUT
    });
    
    walletManager.updateLastUsed(account.address);
    
    await safeSendMessage(
      msg.chat.id, 
      TelegramFormatter.transactionSuccess(receipt.transactionHash, account.address), 
      { parse_mode: 'Markdown' }
    );
    
    // Release the nonce if the transaction was successful
    if (nonceData.release) {
      nonceData.release();
    }
    
    return receipt;
  } catch (error) {
    if (retryCount < CONFIG.MAX_RETRY_COUNT) {
      await safeSendMessage(
        msg.chat.id, 
        `🔄 Retrying (${retryCount + 1}/${CONFIG.MAX_RETRY_COUNT})...\nError: ${error.message.substring(0, 100)}`, 
        { parse_mode: 'Markdown' }
      );
      
      await new Promise(resolve => setTimeout(resolve, 3000));
      return sendMonadMintTx(walletAddress, msg, retryCount + 1);
    }
    
    logger.error('mint_failed', { address: walletAddress, error: error.message, stack: error.stack });
    
    await safeSendMessage(
      msg.chat.id, 
      TelegramFormatter.transactionFailed(error.message, walletAddress), 
      { parse_mode: 'Markdown' }
    );
    
    throw error;
  }
}

// ========== TELEGRAM COMMAND HANDLERS ========== //
bot.onText(/\/start/, async (msg) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  try {
    // First try with Markdown formatting
    await bot.sendMessage(msg.chat.id, TelegramFormatter.helpText(), { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('Error sending help message with Markdown:', error.message);
    
    try {
      // Then try with HTML formatting
      if (TelegramFormatter.helpTextHTML) {
        await bot.sendMessage(msg.chat.id, TelegramFormatter.helpTextHTML(), { parse_mode: 'HTML' });
      } else {
        // Fallback to plain text if HTML method doesn't exist
        throw new Error('HTML formatter not available');
      }
    } catch (htmlError) {
      logger.error('Error sending help message with HTML:', htmlError.message);
      
      try {
        // As a last resort, use plain text
        const plainText = TelegramFormatter.plainHelpText ? 
          TelegramFormatter.plainHelpText() : 
          TelegramFormatter.helpText().replace(/\*/g, '').replace(/\`/g, '');
          
        await bot.sendMessage(msg.chat.id, plainText);
      } catch (plainError) {
        logger.error('All formatting attempts failed:', plainError.message);
      }
    }
  }
});

bot.onText(/\/mint/, async (msg) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  const activeWallets = walletManager.getActiveWallets();
  if (activeWallets.length === 0) {
    return await safeSendMessage(msg.chat.id, '❌ No active wallets configured. Use /addwallet to add wallets.');
  }
  
  const activeContractAddress = contractManager.getActiveContractAddress();
  if (!activeContractAddress) {
    return await safeSendMessage(msg.chat.id, '❌ No active contract configured. Use /contadd to add a contract.');
  }
  
  await safeSendMessage(msg.chat.id, `🚀 Starting batch mint with ${activeWallets.length} wallets on contract ${activeContractAddress.substring(0, 8)}...`);
  
  try {
    const receipts = await Promise.all(activeWallets.map(wallet => sendMonadMintTx(wallet.address, msg)));
    const successful = receipts.filter(r => r).length;
    await safeSendMessage(msg.chat.id, `🎉 Batch mint complete!\n✅ ${successful}/${activeWallets.length} successful`);
  } catch (error) {
    logger.error('batch_mint_error', { error: error.message });
    await safeSendMessage(msg.chat.id, `⚠️ Some mints failed, check /history for details`);
  }
});

bot.onText(/\/status/, async (msg) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  try {
    const activeContract = contractManager.getActiveContract();
    const activeContractAddress = contractManager.getActiveContractAddress();
    
    if (!activeContract || !activeContractAddress) {
      return await safeSendMessage(msg.chat.id, '❌ No active contract configured. Use /contadd to add a contract.');
    }
    
    await safeSendMessage(msg.chat.id, '⏳ Fetching contract status...');
    
    const [total, max] = await Promise.all([
      activeContract.methods.totalSupply().call(),
      activeContract.methods.MAX_SUPPLY().call(),
    ]);
    
    await safeSendMessage(
      msg.chat.id, 
      TelegramFormatter.supplyStatus(total, max, activeContractAddress), 
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    logger.error('status_check_error', { error: error.message });
    await safeSendMessage(msg.chat.id, `❌ Error fetching supply: ${error.message}`);
  }
});

// Contract Management Commands
bot.onText(/\/contracts/, async (msg) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  const contracts = contractManager.getAllContracts();
  await safeSendMessage(
    msg.chat.id, 
    TelegramFormatter.contractList(contracts), 
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/contadd (\S+)(?:\s+(.+))?/, async (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  const address = match[1].trim();
  const label = match[2] ? match[2].trim() : '';
  
  if (!Validator.isValidContractAddress(address)) {
    return await safeSendMessage(msg.chat.id, '❌ Invalid contract address format');
  }
  
  try {
    // Validate contract before adding
    await safeSendMessage(msg.chat.id, '⏳ Validating contract address...');
    const validationResult = await contractManager.validateContract(address);
    
    if (typeof validationResult === 'object' && validationResult.valid === false) {
      return await safeSendMessage(msg.chat.id, `❌ Invalid contract: ${validationResult.reason}`);
    } else if (validationResult === false) {
      return await safeSendMessage(msg.chat.id, '❌ Invalid contract: Required methods not found');
    }
    
    const newContract = contractManager.addContract(address, label);
    logAction('contract_added', { address, label });
    
    await safeSendMessage(
      msg.chat.id, 
      TelegramFormatter.contractAdded(newContract), 
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    await safeSendMessage(msg.chat.id, `❌ Error adding contract: ${error.message}`);
  }
});

bot.onText(/\/contuse (\S+)/, async (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  const address = match[1].trim();
  
  try {
    const activeContract = contractManager.activateContract(address);
    
    logAction('contract_activated', { address });
    await safeSendMessage(
      msg.chat.id, 
      TelegramFormatter.contractActivated(activeContract), 
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    await safeSendMessage(msg.chat.id, `❌ Error activating contract: ${error.message}`);
  }
});

bot.onText(/\/contrem (\S+)/, async (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  const address = match[1].trim();
  
  try {
    const success = contractManager.removeContract(address);
    
    if (success) {
      logAction('contract_removed', { address });
      await safeSendMessage(
        msg.chat.id, 
        TelegramFormatter.contractRemoved(address), 
        { parse_mode: 'Markdown' }
      );
    } else {
      await safeSendMessage(msg.chat.id, '❌ Contract not found');
    }
  } catch (error) {
    await safeSendMessage(msg.chat.id, `❌ Error removing contract: ${error.message}`);
  }
});

// Wallet Management Commands
bot.onText(/\/addwallet (.+)/, async (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;

  const privateKey = match[1].trim();
  try {
    const address = walletManager.addWallet(privateKey);
    await safeSendMessage(msg.chat.id, `✅ Wallet added successfully!\nAddress: ${address}`);
  } catch (error) {
    await safeSendMessage(msg.chat.id, `❌ Error adding wallet: ${error.message}`);
  }
});

bot.onText(/\/wallets/, async (msg) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;

  const wallets = walletManager.getActiveWallets();
  if (wallets.length === 0) {
    return await safeSendMessage(msg.chat.id, '📝 No wallets configured');
  }
  
  await safeSendMessage(
    msg.chat.id, 
    TelegramFormatter.walletList(wallets), 
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/togglewallet (.+)/, async (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;

  const address = match[1].trim();
  const newStatus = walletManager.toggleWallet(address);
  if (newStatus !== null) {
    await safeSendMessage(msg.chat.id, `✅ Wallet ${newStatus ? 'activated' : 'deactivated'}: ${address}`);
  } else {
    await safeSendMessage(msg.chat.id, '❌ Wallet not found');
  }
});

bot.onText(/\/removewallet (.+)/, async (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;

  const address = match[1].trim();
  const success = walletManager.removeWallet(address);
  if (success) {
    await safeSendMessage(msg.chat.id, `✅ Wallet removed: ${address}`);
  } else {
    await safeSendMessage(msg.chat.id, '❌ Wallet not found');
  }
});

// Transaction History Commands
bot.onText(/\/history(?:\s+(\d+))?/, async (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;

  const limit = match[1] ? parseInt(match[1]) : 5;
  const history = txManager.getTransactionHistory(null, limit);
  
  if (history.length === 0) {
    return await safeSendMessage(msg.chat.id, '📜 No transaction history available');
  }
  
  let message = '📜 *Recent Transactions*\n\n';
  
  history.forEach((tx, index) => {
    const date = new Date(tx.timestamp).toLocaleString();
    const statusEmoji = tx.status === 'confirmed' ? '✅' : 
                        tx.status === 'pending' ? '⏳' : '❌';
    
    message += `*${index + 1}. ${statusEmoji} ${tx.status.toUpperCase()}*\n` +
               `Time: ${date}\n` +
               `From: \`${tx.from.substring(0, 10)}...\`\n` +
               `Tx: [${tx.hash.substring(0, 10)}...](${CONFIG.EXPLORER_URL}${tx.hash})\n\n`;
  });
  
  await safeSendMessage(msg.chat.id, message, { 
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });
});

bot.onText(/\/wallethistory (.+)/, async (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;

  const address = match[1].trim();
  if (!Validator.isValidAddress(address)) {
    return await safeSendMessage(msg.chat.id, '❌ Invalid wallet address');
  }

  const history = txManager.getTransactionHistory(address, 10);
  
  if (history.length === 0) {
    return await safeSendMessage(
      msg.chat.id, 
      `📜 No transaction history for \`${address}\``, 
      { parse_mode: 'Markdown' }
    );
  }
  
  let message = `📜 *Transaction History for*\n\`${address}\`\n\n`;
  
  history.forEach((tx, index) => {
    const date = new Date(tx.timestamp).toLocaleString();
    const statusEmoji = tx.status === 'confirmed' ? '✅' : 
                        tx.status === 'pending' ? '⏳' : '❌';
    
    message += `*${index + 1}. ${statusEmoji} ${tx.status.toUpperCase()}*\n` +
               `Time: ${date}\n` +
               `Tx: [${tx.hash.substring(0, 10)}...](${CONFIG.EXPLORER_URL}${tx.hash})\n\n`;
  });
  
  await safeSendMessage(msg.chat.id, message, { 
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });
});

// ========== SERVER SETUP ========== //
app.get('/', (req, res) => res.send('MONAD Mint Bot 🚀'));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  console.log(`🤖 MONAD Mint Bot started on port ${PORT}!`);
});

// Handle bot errors
bot.on('polling_error', (error) => {
  logger.error('Telegram polling error:', {
    message: error.message,
    code: error.code || 'unknown'
  });
});

// Global error handler for unhandled promise rejections
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection:', {
    message: error.message,
    stack: error.stack
  });
});

// Log startup
logAction('bot_started', { 
  wallets: walletManager.getActiveWallets().length,
  contracts: contractManager.getAllContracts().length
});

