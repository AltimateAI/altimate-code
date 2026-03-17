const fs = require('fs')
const path = require('path')

function containsReal(parent, child) {
    let realParent = fs.realpathSync(parent)

    let current = path.isAbsolute(child) ? child : path.resolve(child) // wait, path.resolve normalizes. 
    // If it's relative, we can do path.join(process.cwd(), child) instead of path.resolve? 
    // Let's test with absolute child to keep it simple.
    current = child;

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

console.log("Fixed allows bypass write?:", containsReal('/tmp/project', '/tmp/project/symlink/../new_secret.txt'))
