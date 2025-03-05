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

    const activeContractAddress = contractManager.getActiveContractAddress();
    if (!activeContractAddress) {
      throw new Error('No active contract configured');
    }

    const activeContract = contractManager.getActiveContract();
    const methodNames = contractManager.getActiveContractMethods();
    if (!activeContract.methods[methodNames.mint]) {
      throw new Error(`Mint method '${methodNames.mint}' not found in contract. Verify configuration.`);
    }

    const mintPrice = await contractManager.getMintPrice();
    let gasPrice;
    try {
      const currentGasPrice = await web3.eth.getGasPrice();
      gasPrice = Math.floor(parseInt(currentGasPrice) * 1.15).toString();
      logger.info('Dynamic gas price', { current: currentGasPrice, adjusted: gasPrice });
    } catch (e) {
      gasPrice = CONFIG.GAS_PRICE;
      logger.warn('Using fallback gas price', { price: gasPrice });
    }

    const gasLimit = 800000; // Adjusted gas limit
    logAction('mint_attempt', {
      address: walletAddress,
      retryCount,
      contractAddress: activeContractAddress,
      mintMethod: methodNames.mint,
      mintPrice,
      gasPrice,
      gasLimit
    });

    const account = web3.eth.accounts.privateKeyToAccount(wallet.privateKey);
    const nonce = await txManager.getNonce(account.address);
    const mintData = activeContract.methods[methodNames.mint]().encodeABI();

    const tx = {
      from: account.address,
      to: activeContractAddress,
      data: mintData,
      gas: gasLimit,
      gasPrice: gasPrice,
      chainId: CONFIG.CHAIN_ID,
      nonce,
      value: mintPrice
    };

    logger.info('Transaction parameters', {
      from: account.address,
      to: activeContractAddress,
      method: methodNames.mint,
      gas: gasLimit,
      gasPrice,
      value: mintPrice
    });

    const signedTx = await account.signTransaction(tx);
    const ethValue = web3.utils.fromWei(mintPrice, 'ether');
    const mintMsg = mintPrice !== '0' ? ` with ${ethValue} ETH` : '';

    bot.sendMessage(
      msg.chat.id,
      `⏳ Processing mint (method: ${methodNames.mint}) from ${TelegramFormatter.code(account.address.substring(0, 10) + '...')}${mintMsg}`,
      { parse_mode: 'Markdown' }
    );

    const receipt = await txManager.sendTransaction(signedTx, account.address, {
      to: activeContractAddress,
      gasPrice: gasPrice,
      gasLimit: gasLimit,
      timeout: CONFIG.TX_TIMEOUT,
      value: mintPrice
    });

    walletManager.updateLastUsed(account.address);
    bot.sendMessage(msg.chat.id, TelegramFormatter.transactionSuccess(receipt.transactionHash, account.address), { parse_mode: 'Markdown' });
    return receipt;
  } catch (error) {
    if (error.message.includes('Maximum supply')) {
      bot.sendMessage(msg.chat.id, `❌ Mint Failed: Maximum supply reached`, { parse_mode: 'Markdown' });
      throw error;
    }

    if (error.message.includes('not found in contract')) {
      bot.sendMessage(msg.chat.id, `❌ ${error.message}`, { parse_mode: 'Markdown' });
      throw error;
    }

    if (retryCount < CONFIG.MAX_RETRY_COUNT) {
      bot.sendMessage(msg.chat.id, `🔄 Retrying (${retryCount + 1}/${CONFIG.MAX_RETRY_COUNT})...\nError: ${error.message.substring(0, 100)}`, { parse_mode: 'Markdown' });
      const waitTime = 3000 * Math.pow(2, retryCount);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return sendMonadMintTx(walletAddress, msg, retryCount + 1);
    }

    logger.error('mint_failed', {
      address: walletAddress,
      error: error.message,
      stack: error.stack
    });

    bot.sendMessage(msg.chat.id, TelegramFormatter.transactionFailed(error.message, walletAddress), { parse_mode: 'Markdown' });
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

bot.onText(/\/contaddforce (\S+)(?:\s+(.+))?/, async (msg, match) => {
  if (!checkAdminAccess(msg)) return;
  
  const address = match[1].trim();
  const label = match[2] ? match[2].trim() : '';
  
  if (!Validator.isValidContractAddress(address)) {
    return bot.sendMessage(msg.chat.id, '❌ Invalid contract address format');
  }
  
  try {
    // Check if the address has code (is a contract)
    const code = await web3.eth.getCode(address);
    if (code === '0x') {
      return bot.sendMessage(msg.chat.id, '❌ No contract code found at this address!');
    }
    
    // Add contract without validation
    const defaultMethods = {
      mint: 'mint',
      totalSupply: 'totalSupply',
      maxSupply: 'MAX_SUPPLY'
    };
    
    const newContract = contractManager.addContract(address, label, defaultMethods, true);
    
    let successMsg = `✅ *Contract Added (Forced)*\n` +
                     `Address: \`${address}\`\n` +
                     `Label: ${label || 'Unnamed Contract'}\n\n` +
                     `Default methods set. Use /inspectcontract to detect available methods and /setmethods to configure them.`;
    
    bot.sendMessage(
      msg.chat.id, 
      successMsg, 
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Error adding contract: ${error.message}`);
  }
});
bot.onText(/\/inspectcontract/, async (msg) => {
  if (!checkAdminAccess(msg)) return;
  
  const activeContractAddress = contractManager.getActiveContractAddress();
  if (!activeContractAddress) {
    return bot.sendMessage(msg.chat.id, '❌ No active contract configured.');
  }
  
  bot.sendMessage(msg.chat.id, `🔍 Inspecting contract ${activeContractAddress}...`);
  
  try {
    const inspectionResults = await contractManager.inspectContractMethods(activeContractAddress);
    
    if (!inspectionResults.valid) {
      return bot.sendMessage(msg.chat.id, `❌ Inspection failed: ${inspectionResults.error}`);
    }
    
    let message = '📋 *Contract Method Detection Results*\n\n';
    
    if (inspectionResults.methods.length > 0) {
      message += '*Detected Methods:*\n';
      inspectionResults.methods.forEach(method => {
        message += `- \`${method}\`\n`;
      });
      
      message += '\nUse `/setmethods mintMethod,totalSupplyMethod,maxSupplyMethod` to configure contract methods.';
    } else {
      message += '❌ Could not detect any standard methods.\n\n';
      message += 'You may need to set methods manually with `/setmethods` command.';
    }
    
    // Add gas price info
    try {
      const gasPrice = await web3.eth.getGasPrice();
      const gasPriceGwei = web3.utils.fromWei(gasPrice, 'gwei');
      message += `\n\n*Network Gas Price:* ${gasPriceGwei} Gwei\n`;
      message += `*Bot Gas Price:* ${web3.utils.fromWei(CONFIG.GAS_PRICE, 'gwei')} Gwei\n`;
      message += `*Gas Limit:* ${CONFIG.GAS_LIMIT}\n`;
    } catch (e) {
      message += `\nError getting gas price: ${e.message}\n`;
    }
    
    bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Inspection error: ${error.message}`);
  }
});
bot.onText(/\/setmethods (.+)/, async (msg, match) => {
  if (!checkAdminAccess(msg)) return;
  
  const activeContractAddress = contractManager.getActiveContractAddress();
  if (!activeContractAddress) {
    return bot.sendMessage(msg.chat.id, '❌ No active contract configured. Use /contadd first.');
  }
  
  try {
    // Parse method names from command (format: mintMethod,totalSupplyMethod,maxSupplyMethod)
    const methods = match[1].trim().split(',');
    
    if (methods.length < 1 || methods.length > 3) {
      return bot.sendMessage(msg.chat.id, '❌ Invalid format. Use: /setmethods mintMethod,totalSupplyMethod,maxSupplyMethod');
    }
    
    // Create methods object
    const methodsObj = {
      mint: methods[0],
      totalSupply: methods.length > 1 ? methods[1] : 'totalSupply',
      maxSupply: methods.length > 2 ? methods[2] : 'MAX_SUPPLY'
    };
    
    // Update contract methods
    const updatedContract = contractManager.updateContractMethods(activeContractAddress, methodsObj);
    
    bot.sendMessage(
      msg.chat.id, 
      `✅ Contract methods updated:\n` +
      `Mint: ${methodsObj.mint}\n` +
      `Total Supply: ${methodsObj.totalSupply}\n` +
      `Max Supply: ${methodsObj.maxSupply}`, 
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Error updating methods: ${error.message}`);
  }
});

bot.onText(/\/contadd (\S+)(?:\s+(.+))?/, async (msg, match) => {
  if (!checkAdminAccess(msg)) return;
  
  const address = match[1].trim();
  const label = match[2] ? match[2].trim() : '';
  
  if (!Validator.isValidContractAddress(address)) {
    return bot.sendMessage(msg.chat.id, '❌ Invalid contract address format');
  }
  
  try {
    // Validate contract before adding
    bot.sendMessage(msg.chat.id, '⏳ Validating contract address...');
    const validationResults = await contractManager.validateContract(address);
    
    if (!validationResults.valid) {
      let errorMsg = '❌ Invalid contract: Required methods not found.';
      
      if (validationResults.errors && validationResults.errors.length > 0) {
        errorMsg += '\n\n*Errors:*\n';
        validationResults.errors.slice(0, 3).forEach(err => {
          errorMsg += `- ${err}\n`;
        });
      }
      
      errorMsg += '\n\nTry using /contaddforce to add without validation, then use /inspectcontract and /setmethods to configure manually.';
      
      return bot.sendMessage(msg.chat.id, errorMsg, { parse_mode: 'Markdown' });
    }
    
    // Extract detected method names
    const methods = {
      mint: validationResults.methods.mint?.name || 'mint',
      totalSupply: validationResults.methods.totalSupply?.name || 'totalSupply',
      maxSupply: validationResults.methods.maxSupply?.name || 'MAX_SUPPLY'
    };
    
    // Add the contract
    const newContract = contractManager.addContract(address, label, methods);
    
    let successMsg = `✅ *Contract Added Successfully*\n` +
                     `Address: \`${address}\`\n` +
                     `Label: ${label || 'Unnamed Contract'}\n\n` +
                     `*Detected Methods:*\n` +
                     `- Mint: ${methods.mint}\n` +
                     `- Total Supply: ${methods.totalSupply}\n` +
                     `- Max Supply: ${methods.maxSupply}\n\n` +
                     `Use /contuse ${address} to activate this contract.`;
    
    bot.sendMessage(
      msg.chat.id, 
      successMsg, 
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    bot.sendMessage(
      msg.chat.id, 
      `❌ Error adding contract: ${error.message}\n\nTry using /contaddforce to bypass validation.`
    );
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
        
