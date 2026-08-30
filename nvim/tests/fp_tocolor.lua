-- #263: the addressee on the meta line wears the color the engine resolved
-- (seat color for roster handles, chair color for the chair's addresses); a
-- null toColor falls back to the meta style. The ' to ' glue stays dim either way.
vim.opt.runtimepath:append(vim.env.FP_NVIM)
require('flurryport').setup({})
local render = require('flurryport.render')
render.reset_ids()

local function meta(item)
  local base = {
    at = '2026-08-15T18:00:00Z', id = 'z1', byline = 'author', color = 'green',
    channel = 'room', to = nil, toColor = nil, text = 'hi', mine = false,
    verb = nil, re = nil, panic = false, status = nil, tags = {},
  }
  return render.event({ type = 'feed', item = vim.tbl_extend('force', base, item) })[1]
end

--- The highlight group covering byte offset `at` (0-based) in a rendered line.
local function group_at(line, at)
  for _, hl in ipairs(line.hls) do
    if hl.from <= at and at < hl.to then
      return hl.group
    end
  end
  return nil
end

-- 1. a colored addressee wears its seat group; the ' to ' glue stays dim
local line = meta({ channel = 'mention', to = 'author-2', toColor = 'yellow' })
local to_at = line.text:find('author%-2') - 1
assert(group_at(line, to_at) == 'FlurryPortYellow', 'addressee not in its seat color: ' .. line.text)
local glue_at = line.text:find(' to ') - 1
assert(group_at(line, glue_at + 1) == 'FlurryPortDim', 'the to glue lost its meta style')

-- 2. null toColor falls back to the meta style
line = meta({ channel = 'mention', to = 'nobody', toColor = nil })
to_at = line.text:find('nobody') - 1
assert(group_at(line, to_at) == 'FlurryPortDim', 'unmatched addressee should stay dim')

-- 3. whispers color their addressee the same way
line = meta({ channel = 'whisper', to = 'director', toColor = 'red' })
to_at = line.text:find('director') - 1
assert(group_at(line, to_at) == 'FlurryPortRed', 'whisper addressee not colored: ' .. line.text)
assert(line.text:find(' whispers to director'), 'whisper meta text changed: ' .. line.text)

print('TOCOLOR OK')
