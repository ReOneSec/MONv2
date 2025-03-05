// contracts.js
const fs = require('fs');
const { logger, logAction } = require('./logger');
const Validator = require('./validation');

class ContractManager {
  constructor(web3Instance, contractABI) {
    this.web3 = web3Instance;
    this.contractFile = './saved_contracts.json';
    this.contracts = this.loadContracts();
    this.contractABI = contractABI;
    this.activeContract = null;
    
    // Initialize active contract
    this.initializeActiveContract();
  }
  
  loadContracts() {
    try {
      if (fs.existsSync(this.contractFile)) {
        return JSON.parse(fs.readFileSync(this.contractFile, 'utf8'));
      }
      return [];
    } catch (error) {
      logger.error('Error loading contracts:', error);
      return [];
    }
  }
  
  saveContracts() {
    fs.writeFileSync(this.contractFile, JSON.stringify(this.contracts, null, 2));
  }
  
  initializeActiveContract() {
    // Find active contract or set first one as active if none is active
    const activeContract = this.contracts.find(c => c.active);
    
    if (activeContract) {
      this.activeContract = new this.web3.eth.Contract(
        this.contractABI, 
        activeContract.address
      );
      return activeContract.address;
    } else if (this.contracts.length > 0) {
      // Set first contract as active if none is active
      this.contracts[0].active = true;
      this.saveContracts();
      this.activeContract = new this.web3.eth.Contract(
        this.contractABI, 
        this.contracts[0].address
      );
      return this.contracts[0].address;
    }
    
    return null;
  }
  
  getActiveContract() {
    return this.activeContract;
  }
  
  getActiveContractAddress() {
    const activeContract = this.contracts.find(c => c.active);
    return activeContract ? activeContract.address : null;
  }
  
  getAllContracts() {
    return this.contracts;
  }
  
  addContract(address, label = '', methods = null, force = false) {
    if (!Validator.isValidContractAddress(address)) {
      throw new Error('Invalid contract address format');
    }
    
    const existingContract = this.contracts.find(c => 
      c.address.toLowerCase() === address.toLowerCase()
    );
    
    if (existingContract) {
      throw new Error('Contract already exists');
    }
    
    const newContract = {
      address: address,
      label: label || `Contract ${this.contracts.length + 1}`,
      active: false,
      addedAt: Date.now(),
      methods: methods || {
        mint: 'mint',
        totalSupply: 'totalSupply',
        maxSupply: 'MAX_SUPPLY'
      }
    };
    
    this.contracts.push(newContract);
    this.saveContracts();
    
    logAction('contract_added', { 
      address, 
      label,
      forced: force,
      methods: newContract.methods
    });
    
    return newContract;
  }
  
  activateContract(address) {
    if (!Validator.isValidContractAddress(address)) {
      throw new Error('Invalid contract address format');
    }
    
    const contractToActivate = this.contracts.find(c => 
      c.address.toLowerCase() === address.toLowerCase()
    );
    
    if (!contractToActivate) {
      throw new Error('Contract not found');
    }
    
    // Set all contracts to inactive
    this.contracts.forEach(c => c.active = false);
    
    // Set selected contract to active
    contractToActivate.active = true;
    this.saveContracts();
    
    // Update active contract instance
    this.activeContract = new this.web3.eth.Contract(
      this.contractABI, 
      contractToActivate.address
    );
    
    logAction('contract_activated', { address });
    return contractToActivate;
  }
  
  removeContract(address) {
    if (!Validator.isValidContractAddress(address)) {
      throw new Error('Invalid contract address format');
    }
    
    const initialLength = this.contracts.length;
    const wasActive = this.contracts.find(c => 
      c.address.toLowerCase() === address.toLowerCase() && c.active
    );
    
    this.contracts = this.contracts.filter(c => 
      c.address.toLowerCase() !== address.toLowerCase()
    );
    
    if (this.contracts.length < initialLength) {
      // If we removed the active contract and have other contracts,
      // set the first one as active
      if (wasActive && this.contracts.length > 0) {
        this.contracts[0].active = true;
        this.activeContract = new this.web3.eth.Contract(
          this.contractABI, 
          this.contracts[0].address
        );
      } else if (this.contracts.length === 0) {
        this.activeContract = null;
      }
      
      this.saveContracts();
      logAction('contract_removed', { address });
      return true;
    }
    
    return false;
  }
  
  // Update contract methods
  updateContractMethods(address, methods) {
    const contractIndex = this.contracts.findIndex(c => 
      c.address.toLowerCase() === address.toLowerCase()
    );
    
    if (contractIndex === -1) {
      throw new Error('Contract not found');
    }
    
    this.contracts[contractIndex].methods = methods;
    this.saveContracts();
    
    // If this is the active contract, reinitialize it
    if (this.contracts[contractIndex].active) {
      this.activeContract = new this.web3.eth.Contract(
        this.contractABI, 
        this.contracts[contractIndex].address
      );
    }
    
    logAction('contract_methods_updated', { 
      address, 
      methods 
    });
    
    return this.contracts[contractIndex];
  }
  
  // Get active contract methods
  getActiveContractMethods() {
    const activeContract = this.contracts.find(c => c.active);
    if (!activeContract) return null;
    
    return activeContract.methods || {
      mint: 'mint',
      totalSupply: 'totalSupply',
      maxSupply: 'MAX_SUPPLY'
    };
  }
  
  // Enhanced contract validation with method detection
  async validateContract(address) {
    try {
      const tempContract = new this.web3.eth.Contract([], address);
      
      // Results object to track validation
      const results = {
        valid: false,
        methods: {},
        errors: []
      };
      
      // Helper function to safely call contract methods
      const safeCall = async (methodName, category, alternatives = []) => {
        // Try the primary method name first
        try {
          if (tempContract.methods[methodName]) {
            const result = await tempContract.methods[methodName]().call();
            results.methods[category] = {
              name: methodName,
              value: result,
              exists: true
            };
            logger.info(`Found ${category} method: ${methodName}`, { value: result });
            return true;
          }
        } catch (e) {
          results.errors.push(`Method ${methodName} call failed: ${e.message}`);
          logger.debug(`Method ${methodName} call failed`, { error: e.message });
        }
        
        // Try alternatives
        for (const altMethod of alternatives) {
          try {
            if (tempContract.methods[altMethod]) {
              const result = await tempContract.methods[altMethod]().call();
              results.methods[category] = {
                name: altMethod,
                value: result,
                exists: true
              };
              logger.info(`Found ${category} method: ${altMethod}`, { value: result });
              return true;
            }
          } catch (e) {
            results.errors.push(`Method ${altMethod} call failed: ${e.message}`);
            logger.debug(`Method ${altMethod} call failed`, { error: e.message });
          }
        }
        
        return false;
      };
      
      // Check for supply tracking methods
      const hasSupply = await safeCall('totalSupply', 'totalSupply', 
                                      ['totalMinted', 'supply', 'tokenCount']);
      
      // Check for max supply methods
      const hasMaxSupply = await safeCall('MAX_SUPPLY', 'maxSupply', 
                                         ['maxSupply', 'MAX_TOKENS', 'maxTokens', 'cap']);
      
      // Check for mint method (don't call it, just check existence)
      const mintMethods = ['mint', 'publicMint', 'mintPublic', 'mintToken', 'buyToken'];
      let mintMethodFound = false;
      let mintMethodName = null;
      
      for (const method of mintMethods) {
        if (tempContract.methods[method]) {
          results.methods.mint = {
            name: method,
            exists: true
          };
          mintMethodFound = true;
          mintMethodName = method;
          logger.info(`Found mint method: ${method}`);
          break;
        }
      }
      
      // Check for price methods
      const hasMintPrice = await safeCall('mintPrice', 'mintPrice', 
                                         ['price', 'MINT_PRICE', 'cost', 'mintCost']);
      
      // Determine if contract is valid
      results.valid = mintMethodFound && (hasSupply || hasMaxSupply);
      
      // Log detailed validation results
      logger.info('Contract validation results', results);
      
      return results;
    } catch (error) {
      logger.error('Contract validation error:', error);
      return { 
        valid: false, 
        error: error.message,
        methods: {},
        errors: [`General validation error: ${error.message}`]
      };
    }
  }
  
  // Get methods from a contract by inspection
  async inspectContractMethods(address) {
    try {
      // Check if contract has code
      const code = await this.web3.eth.getCode(address);
      if (code === '0x') {
        return { valid: false, error: 'No contract code found at this address' };
      }
      
      // Create a temporary contract instance
      const tempContract = new this.web3.eth.Contract([], address);
      
      // Common methods to check
      const commonMethods = [
        'mint', 'publicMint', 'mintPublic', 'mintToken', 'buyToken',
        'totalSupply', 'totalMinted', 'supply', 'tokenCount',
        'MAX_SUPPLY', 'maxSupply', 'MAX_TOKENS', 'maxTokens', 'cap',
        'paused', 'mintPrice', 'price', 'cost'
      ];
      
      const foundMethods = [];
      
      for (const method of commonMethods) {
        try {
          // Check if method exists by trying to encode a call to it
          tempContract.methods[method]().encodeABI();
          foundMethods.push(method);
        } catch (e) {
          // Method doesn't exist or has parameters
        }
      }
      
      return {
        valid: true,
        methods: foundMethods
      };
    } catch (error) {
      logger.error('Contract inspection error:', error);
      return {
        valid: false,
        error: error.message
      };
    }
  }
  
  // Get mint price from contract
  async getMintPrice() {
    try {
      const activeContract = this.getActiveContract();
      if (!activeContract) {
        return '0';
      }
      
      // Try different common function names for mint price
      const priceFunctions = ['mintPrice', 'price', 'MINT_PRICE', 'cost', 'mintCost'];
      
      for (const funcName of priceFunctions) {
        try {
          if (activeContract.methods[funcName]) {
            const price = await activeContract.methods[funcName]().call();
            logger.info('Mint price detected', { function: funcName, price });
            return price;
          }
        } catch (e) {
          // Function doesn't exist or can't be called, try next
        }
      }
      
      // If we can't find a price function, assume free mint
      return '0';
    } catch (error) {
      logger.error('Error getting mint price:', error);
      return '0';
    }
  }
}

module.exports = ContractManager;
