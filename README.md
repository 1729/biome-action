# biome-action

A GitHub action that sets up your workflow runner to use Biome

## Usage

### From a GitHub Actions workflow

```yaml

name: Build with Biome
on:
  push:
    branches:
      - master
jobs:
  biome-build:
    runs-on: ubuntu-latest
    steps:
    - name: Initialize Biome artifacts cache directory
      run: |
        sudo mkdir -p /hab/cache/artifacts
        sudo chown runner:docker -R /hab
    - name: Cache Biome artifacts
      uses: actions/cache@v1
      with:
        path: /hab/cache/artifacts
        key: hab-cache-artifacts

    - name: 'Initialize Biome environment'
      uses: 1729/biome-action@action/v1
      with:
        deps: |
          core/git
          core/bio-studio
        # supervisor: true
        #supervisor: |
        #  core/mysql
        #  emergence/php-runtime --bind="database:mysql.default"
        #  emergence/nginx --bind="backend:php-runtime.default"

    - run: bio pkg exec core/git git clone https://github.com/JarvusInnovations/habitat-compose
    - run: bio origin key generate jarvus
    - run: bio pkg build ./habitat-compose/
      env:
        HAB_ORIGIN: jarvus
    # - name: Open tmate/tmux session for remote debug shell
    #   uses: mxschmitt/action-tmate@v1
```

### From another nodejs-powered action

First, install this action as a dependency and add the copied files to your versioned `node_modules/` (GitHub actions requires this):

```bash
npm install --save JarvusInnovations/habitat-action#master
git add -f node_modules/ package.json package-lock.json
git commit -m "chore: add habitat-action to dependencies"
```

Then, in your action, you can do this:

```javascript
async function run() {
    try {
        await require('biome-action');
    } catch (err) {
        core.setFailed(`Failed to run biome-action: ${err.message}`);
        return;
    }

    // ...

    try {
        core.startGroup('Installing Jarvus Hologit');
        await exec('hab pkg install jarvus/hologit');
    } catch (err) {
        core.setFailed(`Failed to install Jarvus Hologit: ${err.message}`);
        return;
    } finally {
        core.endGroup();
    }

    // ...
}
```
