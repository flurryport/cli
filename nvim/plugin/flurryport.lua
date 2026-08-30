-- Commands are registered on load so :FlurryPort works with no config at all.
-- Calling require('flurryport').setup{...} later just overrides the defaults.
if vim.g.loaded_flurryport == 1 then
  return
end
vim.g.loaded_flurryport = 1

require('flurryport').setup({})
