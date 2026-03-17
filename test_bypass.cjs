const fs = require('fs')
const path = require('path')

// Fake containsReal implementation matching the one in the codebase
function containsReal(parent, child) {
    let realParent;
    try {
      realParent = fs.realpathSync(parent)
    } catch {
      return false;
    }

    try {
      const realChild = fs.realpathSync(child)
      const rel = path.relative(realParent, realChild)
      return !path.isAbsolute(rel) && !rel.startsWith("..")
    } catch {
      // Child doesn't exist — walk up to find nearest existing ancestor
    }

    const resolved = path.resolve(child)
    let current = resolved
    const trailing = []
    while (true) {
      try {
        const realAncestor = fs.realpathSync(current)
        const realChild = trailing.length > 0 ? path.join(realAncestor, ...trailing) : realAncestor
        const rel = path.relative(realParent, realChild)
        return !path.isAbsolute(rel) && !rel.startsWith("..")
      } catch {
        const parent_ = path.dirname(current)
        if (parent_ === current) {
          return false;
        }
        trailing.unshift(path.basename(current))
        current = parent_
      }
    }
}

const parent = '/tmp/project'
const child = '/tmp/project/symlink/../new_secret.txt'

console.log("containsReal allows bypass write?:", containsReal(parent, child))
