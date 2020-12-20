const core = require('@actions/core');
const cache = require('@actions/cache');
const fs = require('fs');


const CACHE_LOCK_PATH = '/hab/pkgs/.cached';


// run with error wrapper
try {
    module.exports = run();
} catch(err) {
    core.setFailed(err.message);
}

async function run() {

    // save cache
    if (fs.existsSync(CACHE_LOCK_PATH)) {
        // .cached file is written at beginning of caching, and removed after restore to
        // guard against multiple post scripts trying to save the same cache
        core.info(`Skipping caching, ${CACHE_LOCK_PATH} already exists`);
    } else {
        try {
            core.startGroup(`Saving package cache`);
            fs.writeFileSync(CACHE_LOCK_PATH, '');
            const cacheId = await cache.saveCache(['/hab/pkgs'], 'hab-pkgs');
            core.info(cacheId ? `Saved cache ${cacheId}` : 'No cache saved');
        } catch (err) {
            core.setFailed(`Failed to save package cache: ${err.message}`);
            return;
        } finally {
            core.endGroup();
        }
    }
}
