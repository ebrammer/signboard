const { withBoardTransaction } = require('../fileTransaction');
const { importTrello } = require('./trello');
const { importObsidian } = require('./obsidian');
const { importTasksMd } = require('./tasksmd');

function serializeImport(importer) {
  return (options = {}) => {
    // Preserve each importer's own validation for missing/invalid input.
    if (typeof options.boardRoot !== 'string') return importer(options);
    return withBoardTransaction(options.boardRoot, () => importer(options));
  };
}

module.exports = {
  importTrello: serializeImport(importTrello),
  importObsidian: serializeImport(importObsidian),
  importTasksMd: serializeImport(importTasksMd),
};
