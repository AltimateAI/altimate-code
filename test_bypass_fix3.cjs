const fs = require('fs')
const path = require('path')

fs.rmSync('/tmp/project2', {recursive: true, force: true})
fs.rmSync('/tmp/outside2', {recursive: true, force: true})

fs.mkdirSync('/tmp/project2', {recursive: true})
fs.mkdirSync('/tmp/outside2/sub', {recursive: true})
fs.symlinkSync('/tmp/outside2/sub', '/tmp/project2/symlink')

function containsReal(parent, child) {
    let realParent = fs.realpathSync(parent)

    let current = child;
    const trailing = []
    while (true) {
      try {
        const realAncestor = fs.realpathSync(current)
        console.log("Resolved", current, "->", realAncestor)
        const realChild = trailing.length > 0 ? path.join(realAncestor, ...trailing) : realAncestor
        console.log("realChild:", realChild)
        const rel = path.relative(realParent, realChild)
        return !path.isAbsolute(rel) && !rel.startsWith("..")
      } catch (e) {
        const parent_ = path.dirname(current)
        if (parent_ === current) {
          return false;
        }
        trailing.unshift(path.basename(current))
        current = parent_
      }
    }
}

console.log("Fixed allows bypass write?:", containsReal('/tmp/project2', '/tmp/project2/symlink/../new_secret.txt'))
