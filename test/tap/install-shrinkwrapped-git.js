'use strict'

var fs = require('fs')
var path = require('path')
var resolve = path.resolve
var mkdirp = require('mkdirp')
var rimraf = require('rimraf')
var test = require('tap').test
var npm = require('../../lib/npm')
var common = require('../common-tap')
var chain = require('slide').chain

var mockPath = common.pkg
var parentPath = resolve(mockPath, 'parent')
var parentNodeModulesPath = path.join(parentPath, 'node_modules')
var outdatedNodeModulesPath = resolve(mockPath, 'node-modules-backup')
var childPath = resolve(mockPath, 'child.git')

var gitDaemon
var gitDaemonPID
var git

var parentPackageJSON = JSON.stringify({
  name: 'parent',
  version: '0.1.0'
})

var childPackageJSON = JSON.stringify({
  name: 'child',
  version: '0.1.0'
})

test('setup', function (t) {
  mkdirp.sync(parentPath)
  fs.writeFileSync(resolve(parentPath, 'package.json'), parentPackageJSON)
  process.chdir(parentPath)

  // Setup child
  mkdirp.sync(childPath)
  fs.writeFileSync(resolve(childPath, 'package.json'), childPackageJSON)

  // Setup npm and then git
  npm.load({
    registry: common.registry,
    loglevel: 'silent',
    save: true // Always install packages with --save
  }, function () {
    // It's important to initialize git after npm because it uses config
    initializeGit(function (err, result) {
      t.ifError(err, 'git started up successfully')

      if (!err) {
        gitDaemon = result[result.length - 2]
        gitDaemonPID = result[result.length - 1]
      }

      t.end()
    })
  })
})

test('shrinkwrapped git dependency got updated', function (t) {
  t.comment('test for https://github.com/npm/npm/issues/12718')

  // Prepare the child package git repo with two commits
  prepareChildAndGetRefs(function (err, refs) {
    if (err) { throw err }
    chain([
      // Install & shrinkwrap child package's first commit
      [npm.commands.install, ['git://localhost:' + common.gitPort + '/child.git#' + refs[0]]],
      // Backup node_modules with the first commit
      [fs.rename, parentNodeModulesPath, outdatedNodeModulesPath],
      // Install & shrinkwrap child package's latest commit
      [npm.commands.install, ['git://localhost:' + common.gitPort + '/child.git#' + refs[1].substr(0, 8)]],
      // Restore node_modules with the first commit
      [rimraf, parentNodeModulesPath],
      [fs.rename, outdatedNodeModulesPath, parentNodeModulesPath],
      // Update node_modules
      [npm.commands.install, []]
    ], function () {
      const pkglock = require(path.join(parentPath, 'package-lock.json'))
      t.similar(pkglock, {
        dependencies: {
          child: {
            version: `git://localhost:${common.gitPort}/child.git#${refs[1]}`,
            from: `git://localhost:${common.gitPort}/child.git#${refs[1].substr(0, 8)}`
          }
        }
      }, 'version and from fields are correct in git-based pkglock dep')
      var childPackageJSON = require(path.join(parentNodeModulesPath, 'child', 'package.json'))
      t.equal(
        childPackageJSON._resolved,
        'git://localhost:' + common.gitPort + '/child.git#' + refs[1],
        "Child package wasn't updated"
      )
      t.end()
    })
  })
})

test('clean', function (t) {
  gitDaemon.on('close', t.end)
  process.kill(gitDaemonPID)
})

function prepareChildAndGetRefs (cb) {
  var opts = { cwd: childPath, env: { PATH: process.env.PATH } }
  chain([
    [fs.writeFile, path.join(childPath, 'README.md'), ''],
    git.chainableExec(['add', 'README.md'], opts),
    git.chainableExec(['commit', '-m', 'Add README'], opts),
    git.chainableExec(['log', '--pretty=format:"%H"', '-2'], opts)
  ], function (err) {
    if (err) { return cb(err) }
    var gitLogStdout = arguments[arguments.length - 1]
    var refs = gitLogStdout[gitLogStdout.length - 1].split('\n').map(function (ref) {
      return ref.match(/^"(.+)"$/)[1]
    }).reverse() // Reverse refs order: last, first -> first, last
    cb(null, refs)
  })
}

function initializeGit (cb) {
  git = require('../../lib/utils/git')
  common.makeGitRepo({
    path: childPath,
    commands: [startGitDaemon]
  }, cb)
}

function startGitDaemon (cb) {
  var daemon = git.spawn(
    [
      'daemon',
      '--verbose',
      '--listen=localhost',
      '--export-all',
      '--base-path=' + mockPath, // Path to the dir that contains child.git
      '--reuseaddr',
      '--port=' + common.gitPort
    ],
    {
      cwd: parentPath,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  daemon.stderr.on('data', function findChild (c) {
    var cpid = c.toString().match(/^\[(\d+)\]/)
    if (cpid[1]) {
      this.removeListener('data', findChild)
      cb(null, [daemon, cpid[1]])
    }
  })
}
