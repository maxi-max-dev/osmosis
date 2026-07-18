'use strict';

const { createTemplateGeneratedCard } = require('./card-factory');

function createProvider(config) {
  if (config.provider === 'none') {
    return {
      name: 'none',
      async generateCard() {
        return createTemplateGeneratedCard();
      },
    };
  }

  return {
    name: config.provider,
    async generateCard() {
      throw new Error(`The ${config.provider} provider is not available until Step 4.`);
    },
  };
}

module.exports = { createProvider };
