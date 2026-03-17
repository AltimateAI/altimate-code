const fs = require('fs')
const path = require('path')

function containsRealNative(parent, child) {
    let realParent = fs.realpathSync.native(parent)
    const resolved = path.resolve(child)
    let current = resolved
    const trailing = []
    while (true) {
      try {
        const realAncestor = fs.realpathSync.native(current)
        const realChild = trailing.length > 0 ? path.join(realAncestor, ...trailing) : realAncestor
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

console.log("With .native but using path.resolve. bypass write?:", containsRealNative('/tmp/project2', '/tmp/project2/symlink/../new_secret2.txt'))
