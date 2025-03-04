// transaction.js
const fs = require('fs');
const { logger, logAction } = require('./logger');

class TransactionManager {
  constructor(web3) {
    this.web3 = web3;
    this.pendingNonces = new Map();
    this.txHistory = [];
    this.maxHistoryItems = 100;
    this.historyFile = './tx_history.json';
    
    this.loadHistory();
  }
  
  loadHistory() {
    try {
      if (fs.existsSync(this.historyFile)) {
        this.txHistory = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
        logger.info('Transaction history loaded', { count: this.txHistory.length });
      }
    } catch (error) {
      logger.error('Error loading transaction history', { error: error.message });
    }
  }
  
  saveHistory() {
    try {
      fs.writeFileSync(this.historyFile, JSON.stringify(this.txHistory, null, 2));
    } catch (error) {
      logger.error('Error saving transaction history', { error: error.message });
    }
  }

  async getNonce(address) {
    const onChainNonce = await this.web3.eth.getTransactionCount(address);
    const pendingNonce = this.pendingNonces.get(address) || onChainNonce;
    const nonce = Math.max(onChainNonce, pendingNonce);
    this.pendingNonces.set(address, nonce + 1);
    return nonce;
  }

  async sendTransaction(signedTx, walletAddress, options = {}) {
    const txHash = this.web3.utils.sha3(signedTx.rawTransaction);
    const startTime = Date.now();
    
    const txRecord = {
      hash: txHash,
      from: walletAddress,
      to: options.to || 'unknown',
      timestamp: startTime,
      status: 'pending',
      gasPrice: options.gasPrice || 'unknown',
      gasLimit: options.gasLimit || 'unknown'
    };
    
    this.txHistory.unshift(txRecord);
    if (this.txHistory.length > this.maxHistoryItems) {
      this.txHistory.pop();
    }
    
    this.saveHistory();
    
    const timeout = options.timeout || 120000;
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Transaction timeout')), timeout);
    });
    
    try {
      const receipt = await Promise.race([
        this.web3.eth.sendSignedTransaction(signedTx.rawTransaction),
        timeoutPromise
      ]);
      
      txRecord.status = 'confirmed';
      txRecord.blockNumber = receipt.blockNumber;
      txRecord.gasUsed = receipt.gasUsed;
      this.saveHistory();
      
      logAction('transaction_confirmed', { 
        hash: txHash, 
        from: walletAddress, 
        to: options.to 
      });
      
      return receipt;
    } catch (error) {
      txRecord.status = 'failed';
      txRecord.error = error.message;
      this.saveHistory();
      
      logAction('transaction_failed', { 
        hash: txHash, 
        from: walletAddress, 
        error: error.message 
      });
      
      if (error.message.includes('nonce') || error.message.includes('underpriced')) {
        this.pendingNonces.delete(walletAddress);
      }
      throw error;
    }
  }

  getTransactionHistory(address = null, limit = 10) {
    if (address) {
      return this.txHistory
        .filter(tx => tx.from.toLowerCase() === address.toLowerCase())
        .slice(0, limit);
    }
    return this.txHistory.slice(0, limit);
  }
}

module.exports = TransactionManager;
