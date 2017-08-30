#!/usr/bin/env node
const childProcess = require('child_process');
const fse = require('fs-extra');
const path = require('path');
const process = require('process');
const yargs = require('yargs');

const argv = yargs.options({
    build: {
        description: 'Pipe the Docker context straight to Docker.',
        type: 'boolean',
        default: false
    },
    tag: {
        description: 'The tag to pass to "docker build".  This parameter is only used if --build is specified.  If the value of this parameter is `auto`, a tag name is automatically created from NPM configuration.',
        type: 'string'
    },
    output: {
        description: 'The output path and filename for the Docker context .tar file.',
        type: 'string'
    },
    local: {
        description: 'Build for a local Kubernetes container registry.  This parameter is only used if --build is specified.',
        type: 'boolean',
        default: false
    },
    push: {
        description: 'Push the build image to the docker registry.  This parameter is only used if --build is specified.',
        type: 'boolean',
        default: false
    }
}).help().argv;

if (!argv.build && !argv.output) {
    console.log('Either --build or --output <filename> must be specified.');
    process.exit(1);
}

const componentSrcDir = path.resolve(process.cwd())
const dockerContextDir = fse.mkdtempSync(path.resolve(__dirname, '..', 'docker-context-'));
const componentDestDir = path.resolve(dockerContextDir, 'component');

fse.emptyDirSync(dockerContextDir);
fse.ensureDirSync(componentDestDir);
fse.ensureSymlinkSync(path.resolve(componentSrcDir, '..', 'node_modules'), path.resolve(dockerContextDir, 'node_modules'), 'junction');

// Get the list of production packages.
const productionPackageResult = JSON.parse(childProcess.spawnSync(
    'npm', ['list', '--prod', '--json'],
    { encoding: 'utf8', cwd: componentSrcDir, shell: true }).stdout);
const productionPackages = getPackageList(productionPackageResult.dependencies, path.join(componentSrcDir, 'node_modules'), []);

preparePackage(componentSrcDir, componentDestDir, productionPackages);

const tar = process.platform === 'darwin' ? 'gtar' : 'tar';

// Docker and ConEmu (an otherwise excellent console for Windows) don't get along.
// See: https://github.com/Maximus5/ConEmu/issues/958 and https://github.com/moby/moby/issues/28814
// So if we're running under ConEmu, we need to add an extra -cur_console:i parameter to disable
// ConEmu's hooks and also set ConEmuANSI to OFF so Docker doesn't do anything drastic.
const env = Object.assign({}, process.env);
const extraParameters = [];
if (env.ConEmuANSI === 'ON') {
    env.ConEmuANSI = 'OFF';
    extraParameters.push('-cur_console:i');
}

if (argv.build) {
    const tarProcess = childProcess.spawn(tar, [...extraParameters, '--dereference', '-czf', '-', '*'], {
        cwd: dockerContextDir,
        stdio: ['inherit', 'pipe', 'inherit'],
        env: env,
        shell: true
    });

    let tag = argv.tag;
    if (tag === 'auto') {
        const tagPrefix = argv.local ? 'localhost:5000/' : '';
        const version = !argv.local && process.env.npm_package_version ? process.env.npm_package_version : 'latest';
        const name = process.env.npm_package_config_docker_name
            ? process.env.npm_package_config_docker_name
            : (process.env.npm_package_name ? process.env.npm_package_name : 'UnnamedImage');
        tag = tagPrefix + name + ':' + version;
    }
    const tagArgs = tag ? ['-t', tag] : [];

    const dockerProcess = childProcess.spawn(
        'docker',
        [...extraParameters, 'build', ...tagArgs, '-f', `./component/Dockerfile`, '-'], {
        stdio: ['pipe', 'inherit', 'inherit'],
        env: env
    });

    dockerProcess.on('close', code => {
        fse.removeSync(dockerContextDir);

        if (code === 0 && argv.push) {
            if (!tag) {
                console.error('Can not push an image without a tag.');
                process.exit(1);
            }
            childProcess.spawnSync('docker', ['push', tag], {
                stdio: 'inherit'
            });
        }
        process.exit(code);
    });

    tarProcess.on('close', code => {
        dockerProcess.stdin.end();
    });

    tarProcess.stdout.on('data', data => {
        dockerProcess.stdin.write(data);
    });
} else if (argv.output) {
    const outputPath = path.resolve(process.cwd(), argv.output);
    console.log(outputPath);

    const outputTar = fse.openSync(outputPath, 'w', 0o644);

    const tarProcess = childProcess.spawn(tar, ['--dereference', '-czf', '-', '*'], {
        cwd: dockerContextDir,
        stdio: ['inherit', outputTar, 'inherit'],
        env: env,
        shell: true
    });

    tarProcess.on('close', code => {
        fse.closeSync(outputTar);
        console.log(tarProcess.status);
        fse.removeSync(dockerContextDir);
    });
}

function preparePackage(packageDir, destDir, productionPackages) {
    const packageJson = require(path.join(packageDir, 'package.json'));
    const dockerIncludes = (packageJson.config && packageJson.config.docker && packageJson.config.docker.include || '').split(' ').filter(include => include.length > 0);

    dockerIncludes.forEach(function(include) {
        const src = path.resolve(packageDir, include);
        const dest = path.resolve(destDir, include);

        if (include === 'node_modules') {
            fse.ensureDirSync(dest);
            prepareNodeModules(src, dest, productionPackages);
            return;
        }

        const type = fse.statSync(src).isFile() ? 'file' : 'junction'

        // On Windows we can't create symlinks to files without special permissions.
        // So just copy the file instead.  Usually creating directory junctions is
        // fine without special permissions, but fall back on copying in the unlikely
        // event that fails, too.
        try {
            fse.ensureSymlinkSync(src, dest, type);
        } catch(e) {
            fse.copySync(src, dest);
        }
    });
}

function prepareNodeModules(packageDir, destDir, productionPackages) {
    const subPackages = fse.readdirSync(packageDir);
    subPackages.forEach(function(subPackageName) {
        const src = path.join(packageDir, subPackageName);
        const dest = path.join(destDir, subPackageName);

        if (subPackageName[0] === '@') {
            // This is a scope directory, recurse.
            fse.ensureDirSync(dest);
            prepareNodeModules(src, dest, productionPackages);
            return;
        }

        if (productionPackages.indexOf(src) == -1) {
            // Not a production dependency, skip it.
            return;
        }

        const stat = fse.lstatSync(src);
        if (stat.isSymbolicLink()) {
            // This is a link to another package, presumably created by Lerna.
            fse.ensureDirSync(dest);
            preparePackage(src, dest, productionPackages);
            return;
        }


        // Regular package, link/copy the whole thing.
        try {
            const type = stat.isFile() ? 'file' : 'junction'
            fse.ensureSymlinkSync(src, dest, type);
        } catch(e) {
            fse.copySync(src, dest);
        }
    });
}

function getPackageList(dependencies, basePath, result) {
    if (!dependencies) {
        return result;
    }

    Object.keys(dependencies).forEach(function(dependencyName) {
        const dependencyDetails = dependencies[dependencyName];
        if (dependencyDetails.extraneous) {
            return;
        }

        let dependencyDir = path.join(basePath, dependencyName.replace(/\//g, path.sep));

        // Does this directory exist?  If not, imitate node's module resolution by walking
        // up the directory tree.
        while (!fse.existsSync(dependencyDir)) {
            const upOne = path.resolve(dependencyDir, '..', '..', '..', 'node_modules', path.basename(dependencyDir));
            if (upOne === dependencyDir) {
                break;
            }
            dependencyDir = upOne;
        }

        result.push(dependencyDir);

        if (dependencyDetails.dependencies) {
            getPackageList(dependencyDetails.dependencies, path.join(dependencyDir, 'node_modules'), result);
        }
    });

    return result;
}
