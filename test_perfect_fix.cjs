const fs = require('fs')
const path = require('path')

function containsRealSecure(parent, child) {
    let realParent;
    try {
      realParent = fs.realpathSync.native(parent)
    } catch {
      return false;
    }

    try {
      const realChild = fs.realpathSync.native(child)
      const rel = path.relative(realParent, realChild)
      return !path.isAbsolute(rel) && !rel.startsWith("..")
    } catch {
    }

    let segments = child.split(path.sep).filter(Boolean);
    let absolute = path.isAbsolute(child);
    
    let trailing = [];
    while (segments.length > 0) {
      let current = (absolute ? '/' : '') + segments.join(path.sep)
      try {
        const realAncestor = fs.realpathSync.native(current)
        const realChild = trailing.length > 0 ? path.join(realAncestor, ...trailing) : realAncestor
        const rel = path.relative(realParent, realChild)
        return !path.isAbsolute(rel) && !rel.startsWith("..")
      } catch (e) {
        trailing.unshift(segments.pop())
      }
    }
    return false;
}

console.log("Secure bypass?:", containsRealSecure('/tmp/project2', '/tmp/project2/symlink/../new_secret3.txt'))
