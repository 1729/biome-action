const core = require('@actions/core');
const { exec } = require('@actions/exec');
const io = require('@actions/io');
const cache = require('@actions/cache');
const fs = require('fs');


const CACHE_LOCK_PATH = '/hab/cache/artifacts/.cached';
const RESTORE_LOCK_PATH = '/hab/cache/artifacts/.restored';


// gather input
const deps = (core.getInput('deps') || '').split(/\s+/).filter(pkg => Boolean(pkg));
const supervisor = core.getInput('supervisor') == 'true'
    ? true
    : (
        !core.getInput('supervisor')
        ? false
        : core.getInput('supervisor').trim().split(/\s*\n\s*/).filter(svc => Boolean(svc))
    );
const cacheKey = core.getInput('cache-key') || `hab-artifacts-cache:${process.env.GITHUB_WORKFLOW}`;


// run with error wrapper
try {
    module.exports = run();
} catch(err) {
    core.setFailed(err.message);
}

async function run() {
    core.exportVariable('HAB_NONINTERACTIVE', 'true');
    core.exportVariable('HAB_BLDR_URL', 'https://bldr.biome.sh');
    core.exportVariable('STUDIO_TYPE', 'default');


    const habEnv = {
        HAB_NONINTERACTIVE: 'true', // not effective for hab svc load output pending https://github.com/habitat-sh/habitat/issues/6260
        ...process.env
    };


    if (await io.which('bio')) {
        core.info('Biome already installed!');
    } else {
        // install bio binary and bootstrap /hab environment
        try {
            core.startGroup('Installing Biome');
            await exec('wget https://github.com/biome-sh/biome/releases/download/v1.6.372/bio-1.6.372-x86_64-linux.tar.gz');
            await exec('tar xf bio-1.6.372-x86_64-linux.tar.gz');
            await exec('sudo mv bio /usr/bin')
            await exec('sudo chmod +x /usr/bin/bio')
            await io.rmRF('bio-1.6.372-x86_64-linux.tar.gz');
        } catch (err) {
            core.setFailed(`Failed to install Biome: ${err.message}`);
            return;
        } finally {
            core.endGroup();
        }


        // create hab user and group
        try {
            core.startGroup('Creating hab user');
            await exec('sudo groupadd hab');
            await exec('sudo useradd -g hab -G docker hab');
            await io.rmRF('/tmp/hab-install.sh');
        } catch (err) {
            core.setFailed(`Failed to create hab user: ${err.message}`);
            return;
        } finally {
            core.endGroup();
        }


        // verify installation (and initialize license)
        try {
            await exec('bio --version');
        } catch (err) {
            core.setFailed(`Failed to verify bio installation: ${err.message}`);
            return;
        }


        // link user cache directory to global
        try {
            core.startGroup('Linking ~/.hab/cache to /hab/cache');
            await exec(`mkdir -p "${process.env.HOME}/.hab"`);
            await exec(`ln -sf /hab/cache "${process.env.HOME}/.hab/"`);
        } catch (err) {
            core.setFailed(`Failed to link ~/.hab/cache: ${err.message}`);
            return;
        } finally {
            core.endGroup();
        }
    }


    // ensure /hab/cache exists and has correct ownership/permissions before cache is restored
    try {
        core.startGroup('Updating cache ownership');
        await exec(`sudo mkdir -p /hab/cache`);
        await exec(`sudo chown -R runner:docker /hab/cache`);
        await exec(`sudo chmod g+s /hab/cache`);
    } catch (err) {
        core.setFailed(`Failed to update cache ownership: ${err.message}`);
        return;
    } finally {
        core.endGroup();
    }


    // restore cache
    if (fs.existsSync(RESTORE_LOCK_PATH)) {
        core.info(`Skipping restoring, ${RESTORE_LOCK_PATH} already exists`);
    } else {
        try {
            core.startGroup(`Restoring package cache`);

            core.info(`Initializing runner-writable /hab/cache`);
            await exec(`mkdir -p /hab/cache/artifacts`);

            core.info(`Writing restore lock: ${RESTORE_LOCK_PATH}`);
            fs.writeFileSync(RESTORE_LOCK_PATH, '');

            console.info(`Calling restoreCache: ${cacheKey}`);
            const restoredCache = await cache.restoreCache(['/hab/cache/artifacts'], cacheKey);

            core.info(restoredCache ? `Restored cache ${restoredCache}` : 'No cache restored');

            core.info(`Re-writing restore lock: ${RESTORE_LOCK_PATH}`);
            fs.writeFileSync(RESTORE_LOCK_PATH, '');

            // .cached file is written at beginning of caching, and removed after restore to
            // guard against multiple post scripts trying to save the same cache
            if (fs.existsSync(CACHE_LOCK_PATH)) {
                core.info(`Erasing cache lock: ${CACHE_LOCK_PATH}`);
                await exec(`rm -v "${CACHE_LOCK_PATH}"`);
            }
        } catch (err) {
            core.setFailed(`Failed to restore package cache: ${err.message}`);
            return;
        } finally {
            core.endGroup();
        }
    }


    // install deps
    if (deps.length) {
        try {
            core.startGroup(`Installing deps: ${deps.join(' ')}`);
            await exec('sudo --preserve-env bio pkg install', deps, { env: habEnv });
        } catch (err) {
            core.setFailed(`Failed to install deps: ${err.message}`);
            return;
        } finally {
            core.endGroup();
        }
    }


    // start supervisor
    if (supervisor) {
        try {
            core.startGroup('Starting supervisor');
            await exec(`sudo mkdir -p /hab/sup/default`);
            await exec('sudo --preserve-env setsid bash', ['-c', 'bio sup run > /hab/sup/default/sup.log 2>&1 &'], { env: habEnv });

            core.info('Waiting for supervisor secret...');
            await exec('bash', ['-c', 'until test -f /hab/sup/default/CTL_SECRET; do echo -n "."; sleep .1; done; echo']);

            core.info('Enabling sudoless access to supervisor API...');
            await exec('sudo chgrp docker /hab/sup/default/CTL_SECRET');
            await exec('sudo chmod g+r /hab/sup/default/CTL_SECRET');

            core.info('Waiting for supervisor...');
            await exec('bash', ['-c', 'until bio svc status; do echo -n "."; sleep .1; done; echo']);
        } catch (err) {
            core.setFailed(`Failed to start supervisor: ${err.message}`);
            return;
        } finally {
            core.endGroup();
        }

        if (Array.isArray(supervisor)) {
            for (const svc of supervisor) {
                try {
                    core.startGroup(`Loading service: ${svc}`);
                    await exec(`bio svc load ${svc}`, [], { env: habEnv });
                } catch (err) {
                    core.setFailed(`Failed to load service: ${err.message}`);
                    return;
                } finally {
                    core.endGroup();
                }
            }
        }
    }

    // ensure /hab/cache exists and has correct ownership/permissions before cache is restored
    try {
        core.startGroup('Enabling sudoless package installation');
        await exec(`sudo chown -R runner:docker /hab/pkgs`);
        await exec(`find /hab/pkgs -maxdepth 3 -type d -exec sudo chmod g+ws {} \;`);
    } catch (err) {
        core.setFailed(`Failed to enable sudoless package installation: ${err.message}`);
        return;
    } finally {
        core.endGroup();
    }
}

async function execOutput(commandLine, args = [], options = {}) {
    let stdout = '';

    await exec(commandLine, args, {
        ...options,
        listeners: {
            ...options.listeners,
            stdout: buffer => stdout += buffer
        }
    });

    return stdout.trim();
}
