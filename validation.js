// validation.js
const Web3 = require('web3');
const web3 = new Web3(); // No provider needed for validation

class Validator {
  static isValidPrivateKey(key) {
    try {
      // Ensure key has 0x prefix
      if (!key.startsWith('0x')) {
        key = '0x' + key;
      }
      
      // Private key should be 32 bytes (64 hex chars) + '0x' prefix
      if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
        return false;
      }
      
      // Try to create an account with the key
      const account = web3.eth.accounts.privateKeyToAccount(key);
      return !!account.address;
    } catch (error) {
      return false;
    }
  }

  static isValidAddress(address) {
    return web3.utils.isAddress(address);
  }
  
  static isValidContractAddress(address) {
    // Basic validation for contract address
    // In a production environment, you might want to check if it's actually a contract
    return web3.utils.isAddress(address);
  }
}

module.exports = Validator;
