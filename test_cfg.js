const config = {}
const _ = require("lodash") // Assuming lodash is installed, or I'll just mock defaultsDeep
function defaultsDeep(dest, src) { return Object.assign({}, src, dest) }
const cfg = defaultsDeep(config, {
  permission: {
    "*.env": "ask",
  },
  bash: {
    "rm -rf *": "deny"
  }
})
console.log(cfg.permission)
console.log(cfg.permission.bash)
