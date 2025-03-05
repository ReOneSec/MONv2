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
  
  addContract(address, label = '') {
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
      addedAt: Date.now()
    };
    
    this.contracts.push(newContract);
    this.saveContracts();
    
    logAction('contract_added', { address, label });
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
  
  // Verify if contract has required methods (basic validation)
  async validateContract(address) {
    try {
      const tempContract = new this.web3.eth.Contract(this.contractABI, address);
      // Try to call the methods to verify they exist
      await Promise.all([
        tempContract.methods.totalSupply().call(),
        tempContract.methods.MAX_SUPPLY().call()
      ]);
      return true;
    } catch (error) {
      logger.error('Contract validation error:', error);
      return false;
    }
  }
}

module.exports = ContractManager;
