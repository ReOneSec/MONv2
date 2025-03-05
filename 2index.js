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
    const nonce = await txManager.getNonce(account.address);
    
    const tx = {
      from: account.address,
      to: activeContractAddress,
      data: activeContract.methods.mint().encodeABI(),
      gas: CONFIG.GAS_LIMIT,
      gasPrice: CONFIG.GAS_PRICE,
      chainId: CONFIG.CHAIN_ID,
      nonce
    };

    const signedTx = await account.signTransaction(tx);
    
    bot.sendMessage(msg.chat.id, `⏳ Processing mint from ${TelegramFormatter.code(account.address.substring(0, 10) + '...')}`, { parse_mode: 'Markdown' });
    
    const receipt = await txManager.sendTransaction(signedTx, account.address, {
      to: activeContractAddress,
      gasPrice: CONFIG.GAS_PRICE,
      gasLimit: CONFIG.GAS_LIMIT,
      timeout: CONFIG.TX_TIMEOUT
    });
    
    walletManager.updateLastUsed(account.address);
    
    bot.sendMessage(msg.chat.id, TelegramFormatter.transactionSuccess(receipt.transactionHash, account.address), { parse_mode: 'Markdown' });
    return receipt;
  } catch (error) {
    if (retryCount < CONFIG.MAX_RETRY_COUNT) {
      bot.sendMessage(msg.chat.id, `🔄 Retrying (${retryCount + 1}/${CONFIG.MAX_RETRY_COUNT})...\nError: ${error.message.substring(0, 100)}`, { parse_mode: 'Markdown' });
      await new Promise(resolve => setTimeout(resolve, 3000));
      return sendMonadMintTx(walletAddress, msg, retryCount + 1);
    }
    
    logger.error('mint_failed', { address: walletAddress, error: error.message, stack: error.stack });
    bot.sendMessage(msg.chat.id, TelegramFormatter.transactionFailed(error.message, walletAddress), { parse_mode: 'Markdown' });
    throw error;
  }
}

// ========== TELEGRAM COMMAND HANDLERS ========== //
bot.onText(/\/start/, (msg) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  bot.sendMessage(msg.chat.id, TelegramFormatter.helpText(), { parse_mode: 'Markdown' });
});

bot.onText(/\/mint/, (msg) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  const activeWallets = walletManager.getActiveWallets();
  if (activeWallets.length === 0) {
    return bot.sendMessage(msg.chat.id, '❌ No active wallets configured. Use /addwallet to add wallets.');
  }
  
  const activeContractAddress = contractManager.getActiveContractAddress();
  if (!activeContractAddress) {
    return bot.sendMessage(msg.chat.id, '❌ No active contract configured. Use /contadd to add a contract.');
  }
  
  bot.sendMessage(msg.chat.id, `🚀 Starting batch mint with ${activeWallets.length} wallets on contract ${activeContractAddress.substring(0, 8)}...`);
  
  Promise.all(activeWallets.map(wallet => sendMonadMintTx(wallet.address, msg)))
    .then(receipts => {
      const successful = receipts.filter(r => r).length;
      bot.sendMessage(msg.chat.id, `🎉 Batch mint complete!\n✅ ${successful}/${activeWallets.length} successful`);
    })
    .catch(error => {
      logger.error('batch_mint_error', { error: error.message });
      bot.sendMessage(msg.chat.id, `⚠️ Some mints failed, check /history for details`);
    });
});

bot.onText(/\/status/, async (msg) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  try {
    const activeContract = contractManager.getActiveContract();
    const activeContractAddress = contractManager.getActiveContractAddress();
    
    if (!activeContract || !activeContractAddress) {
      return bot.sendMessage(msg.chat.id, '❌ No active contract configured. Use /contadd to add a contract.');
    }
    
    bot.sendMessage(msg.chat.id, '⏳ Fetching contract status...');
    
    const [total, max] = await Promise.all([
      activeContract.methods.totalSupply().call(),
      activeContract.methods.MAX_SUPPLY().call(),
    ]);
    
    bot.sendMessage(
      msg.chat.id, 
      TelegramFormatter.supplyStatus(total, max, activeContractAddress), 
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    logger.error('status_check_error', { error: error.message });
    bot.sendMessage(msg.chat.id, `❌ Error fetching supply: ${error.message}`);
  }
});

// Contract Management Commands
bot.onText(/\/contracts/, (msg) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  const contracts = contractManager.getAllContracts();
  bot.sendMessage(
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
    return bot.sendMessage(msg.chat.id, '❌ Invalid contract address format');
  }
  
  try {
    // Validate contract before adding
    bot.sendMessage(msg.chat.id, '⏳ Validating contract address...');
    const isValid = await contractManager.validateContract(address);
    
    if (!isValid) {
      return bot.sendMessage(msg.chat.id, '❌ Invalid contract: Required methods not found');
    }
    
    const newContract = contractManager.addContract(address, label);
    logAction('contract_added', { address, label });
    
    bot.sendMessage(
      msg.chat.id, 
      TelegramFormatter.contractAdded(newContract), 
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Error adding contract: ${error.message}`);
  }
});

bot.onText(/\/contuse (\S+)/, (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  const address = match[1].trim();
  
  try {
    const activeContract = contractManager.activateContract(address);
    
    logAction('contract_activated', { address });
    bot.sendMessage(
      msg.chat.id, 
      TelegramFormatter.contractActivated(activeContract), 
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Error activating contract: ${error.message}`);
  }
});

bot.onText(/\/contrem (\S+)/, (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;
  
  const address = match[1].trim();
  
  try {
    const success = contractManager.removeContract(address);
    
    if (success) {
      logAction('contract_removed', { address });
      bot.sendMessage(
        msg.chat.id, 
        TelegramFormatter.contractRemoved(address), 
        { parse_mode: 'Markdown' }
      );
    } else {
      bot.sendMessage(msg.chat.id, '❌ Contract not found');
    }
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Error removing contract: ${error.message}`);
  }
});

// Wallet Management Commands
bot.onText(/\/addwallet (.+)/, (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;

  const privateKey = match[1].trim();
  try {
    const address = walletManager.addWallet(privateKey);
    bot.sendMessage(msg.chat.id, `✅ Wallet added successfully!\nAddress: ${address}`);
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Error adding wallet: ${error.message}`);
  }
});

bot.onText(/\/wallets/, (msg) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;

  const wallets = walletManager.getActiveWallets();
  if (wallets.length === 0) {
    return bot.sendMessage(msg.chat.id, '📝 No wallets configured');
  }
  
  bot.sendMessage(msg.chat.id, TelegramFormatter.walletList(wallets), { parse_mode: 'Markdown' });
});

bot.onText(/\/togglewallet (.+)/, (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;

  const address = match[1].trim();
  const newStatus = walletManager.toggleWallet(address);
  if (newStatus !== null) {
    bot.sendMessage(msg.chat.id, `✅ Wallet ${newStatus ? 'activated' : 'deactivated'}: ${address}`);
  } else {
    bot.sendMessage(msg.chat.id, '❌ Wallet not found');
  }
});

bot.onText(/\/removewallet (.+)/, (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;

  const address = match[1].trim();
  const success = walletManager.removeWallet(address);
  if (success) {
    bot.sendMessage(msg.chat.id, `✅ Wallet removed: ${address}`);
  } else {
    bot.sendMessage(msg.chat.id, '❌ Wallet not found');
  }
});

// Transaction History Commands
bot.onText(/\/history(?:\s+(\d+))?/, (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;

  const limit = match[1] ? parseInt(match[1]) : 5;
  const history = txManager.getTransactionHistory(null, limit);
  
  if (history.length === 0) {
    return bot.sendMessage(msg.chat.id, '📜 No transaction history available');
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
  
  bot.sendMessage(msg.chat.id, message, { 
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });
});

bot.onText(/\/wallethistory (.+)/, (msg, match) => {
  if (msg.from.id !== CONFIG.ADMIN_ID) return;

  const address = match[1].trim();
  if (!Validator.isValidAddress(address)) {
    return bot.sendMessage(msg.chat.id, '❌ Invalid wallet address');
  }

  const history = txManager.getTransactionHistory(address, 10);
  
  if (history.length === 0) {
    return bot.sendMessage(msg.chat.id, `📜 No transaction history for \`${address}\``, { parse_mode: 'Markdown' });
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
  
  bot.sendMessage(msg.chat.id, message, { 
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
  logger.error('Telegram polling error:', error);
});

// Log startup
logAction('bot_started', { 
  wallets: walletManager.getActiveWallets().length,
  contracts: contractManager.getAllContracts().length
});
                                 
