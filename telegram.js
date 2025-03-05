// telegram.js
class TelegramFormatter {
  static code(text) {
    return `\`${text}\``;
  }
  
  static transactionSuccess(txHash, address) {
    return `✅ *Mint Successful!*\n` +
           `From: ${this.code(address.substring(0, 10) + '...')}\n` +
           `[View Transaction](https://testnet.monadexplorer.com/tx/${txHash})`;
  }
  
  static transactionFailed(error, address) {
    return `❌ *Mint Failed*\n` +
           `From: ${this.code(address.substring(0, 10) + '...')}\n` +
           `Error: ${error.substring(0, 100)}`;
  }
  
  static supplyStatus(total, max, contractAddress) {
    const percentage = (total / max * 100).toFixed(2);
    return `📊 *NFT Supply Status*\n` +
           `Contract: ${this.code(contractAddress)}\n` +
           `Current Supply: ${this.code(total)}\n` +
           `Max Supply: ${this.code(max)}\n` +
           `Progress: ${this.code(percentage + '%')}`;
  }
  
  static walletList(wallets) {
    if (wallets.length === 0) {
      return '📝 No wallets configured';
    }
    
    let message = `📝 *Wallet List* (${wallets.length} wallets)\n\n`;
    
    wallets.forEach((wallet, index) => {
      const lastUsed = wallet.lastUsed 
        ? new Date(wallet.lastUsed).toLocaleString() 
        : 'Never';
      
      message += `*${index + 1}. ${wallet.label || 'Wallet'}*\n` +
                 `Address: ${this.code(wallet.address)}\n` +
                 `Status: ${wallet.active ? '✅ Active' : '❌ Inactive'}\n` +
                 `Last Used: ${lastUsed}\n\n`;
    });
    
    return message;
  }
  
  static contractList(contracts) {
    if (contracts.length === 0) {
      return '📝 No contracts configured';
    }
    
    let message = `📝 *Contract List* (${contracts.length} contracts)\n\n`;
    
    contracts.forEach((contract, index) => {
      message += `*${index + 1}. ${contract.label || 'Contract'}*\n` +
                 `Address: ${this.code(contract.address)}\n` +
                 `Status: ${contract.active ? '✅ Active' : '❌ Inactive'}\n` +
                 `Added: ${new Date(contract.addedAt).toLocaleString()}\n\n`;
    });
    
    return message;
  }
  
  static helpText() {
    return `🤖 *MONAD Mint Bot*\n\n` +
           `*Available Commands:*\n\n` +
           `*Minting Commands:*\n` +
           `/mint - Start minting with all active wallets\n` +
           `/status - Check NFT contract supply status\n\n` +
           
           `*Contract Management:*\n` +
           `/contadd \`<address>\` \`[label]\` - Add a new contract address\n` +
           `/contuse \`<address>\` - Switch to a different contract\n` +
           `/contrem \`<address>\` - Remove a contract address\n` +
           `/contracts - List all saved contracts\n\n` +
           
           `*Wallet Management:*\n` +
           `/addwallet \`<private_key>\` - Add a new wallet\n` +
           `/wallets - List all configured wallets\n` +
           `/togglewallet \`<address>\` - Enable/disable a wallet\n` +
           `/removewallet \`<address>\` - Remove a wallet\n\n` +
           
           `*History:*\n` +
           `/history \`[count]\` - Show recent transaction history\n` +
           `/wallethistory \`<address>\` - Show history for a specific wallet`;
  }
  
  static plainHelpText() {
    return `🤖 MONAD Mint Bot\n\n` +
           `Available Commands:\n\n` +
           `Minting Commands:\n` +
           `/mint - Start minting with all active wallets\n` +
           `/status - Check NFT contract supply status\n\n` +
           
           `Contract Management:\n` +
           `/contadd <address> [label] - Add a new contract address\n` +
           `/contuse <address> - Switch to a different contract\n` +
           `/contrem <address> - Remove a contract address\n` +
           `/contracts - List all saved contracts\n\n` +
           
           `Wallet Management:\n` +
           `/addwallet <private_key> - Add a new wallet\n` +
           `/wallets - List all configured wallets\n` +
           `/togglewallet <address> - Enable/disable a wallet\n` +
           `/removewallet <address> - Remove a wallet\n\n` +
           
           `History:\n` +
           `/history [count] - Show recent transaction history\n` +
           `/wallethistory <address> - Show history for a specific wallet`;
  }
  
  static helpTextHTML() {
    return `<b>🤖 MONAD Mint Bot</b>\n\n` +
           `<b>Available Commands:</b>\n\n` +
           `<b>Minting Commands:</b>\n` +
           `/mint - Start minting with all active wallets\n` +
           `/status - Check NFT contract supply status\n\n` +
           
           `<b>Contract Management:</b>\n` +
           `/contadd &lt;address&gt; [label] - Add a new contract address\n` +
           `/contuse &lt;address&gt; - Switch to a different contract\n` +
           `/contrem &lt;address&gt; - Remove a contract address\n` +
           `/contracts - List all saved contracts\n\n` +
           
           `<b>Wallet Management:</b>\n` +
           `/addwallet &lt;private_key&gt; - Add a new wallet\n` +
           `/wallets - List all configured wallets\n` +
           `/togglewallet &lt;address&gt; - Enable/disable a wallet\n` +
           `/removewallet &lt;address&gt; - Remove a wallet\n\n` +
           
           `<b>History:</b>\n` +
           `/history [count] - Show recent transaction history\n` +
           `/wallethistory &lt;address&gt; - Show history for a specific wallet`;
  }
  
  static contractAdded(contract) {
    return `✅ *Contract Added*\n` +
           `Address: ${this.code(contract.address)}\n` +
           `Label: ${contract.label}\n\n` +
           `Use /contuse ${contract.address} to activate this contract.`;
  }
  
  static contractActivated(contract) {
    return `✅ *Active Contract Changed*\n` +
           `Now using: ${this.code(contract.label)}\n` +
           `Address: ${this.code(contract.address)}`;
  }
  
  static contractRemoved(address) {
    return `✅ *Contract Removed*\n` +
           `Address: ${this.code(address)}`;
  }
  
  static escapeMarkdown(text) {
    if (!text) return '';
    return text
      .replace(/\*/g, '\\*')
      .replace(/_/g, '\\_')
      .replace(/`/g, '\\`')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');
  }
}

module.exports = TelegramFormatter;
