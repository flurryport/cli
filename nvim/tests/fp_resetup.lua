vim.opt.runtimepath:append(vim.env.FP_NVIM)
-- The README's own lazy.nvim recipe: plugin/flurryport.lua registers the command on
-- load, then the plugin manager calls setup(opts). Our own command is not a clash.
local warned = nil
vim.notify = function(msg, lvl) warned = msg end

vim.cmd('runtime plugin/flurryport.lua')
assert(vim.api.nvim_get_commands({})['FlurryPORT'], 'plugin file did not register the command')

require('flurryport').setup({ presence_interval = 0 })
assert(warned == nil, 're-setup warned about its own command: ' .. tostring(warned))
assert(vim.api.nvim_get_commands({})['FlurryPORT'], 'command lost on re-setup')
assert(require('flurryport').config.presence_interval == 0, 're-setup did not apply opts')

-- A rename on re-setup moves the surface: the new name exists, the old one is gone.
require('flurryport').setup({ command = 'FlurryRoom' })
assert(warned == nil, 'rename warned: ' .. tostring(warned))
assert(vim.api.nvim_get_commands({})['FlurryRoom'], 'renamed command not registered')
assert(vim.api.nvim_get_commands({})['FlurryPORT'] == nil, 'old command left behind after rename')
print('RESETUP OK')
