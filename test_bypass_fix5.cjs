const fs = require('fs')
const path = require('path')

function containsRealNativeWithDirname(parent, child) {
    let realParent = fs.realpathSync.native(parent)
    let current = child // NO path.resolve(child)
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

console.log("With dirname and .native bypass write?:", containsRealNativeWithDirname('/tmp/project2', '/tmp/project2/symlink/../new_secret5.txt'))
