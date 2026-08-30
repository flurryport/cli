vim.opt.runtimepath:append(vim.env.FP_NVIM)
-- Somebody else got here first with :Fp
vim.api.nvim_create_user_command('FlurryPORT', function() vim.g.other_ran = true end, {})
local warned = nil
vim.notify = function(msg, lvl) warned = msg end

require('flurryport').setup({})

assert(warned and warned:find('already taken'), 'no collision warning: ' .. tostring(warned))
-- Their command is INTACT, not clobbered.
vim.cmd('FlurryPORT')
assert(vim.g.other_ran == true, 'we clobbered another plugin\'s command')
-- And we still work under the long name.
-- A rename gets our surface back without touching theirs.
require('flurryport').setup({ command = 'FlurryRoom' })
assert(vim.api.nvim_get_commands({})['FlurryRoom'], 'rename did not register')
vim.g.other_ran = false
vim.cmd('FlurryPORT')
assert(vim.g.other_ran == true, 'the rename stole their command back')
print('COLLIDE OK')
