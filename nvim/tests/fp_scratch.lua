-- #282: the scratch channel renders marked - out-of-band commentary, never
-- direction - and the struck mark rides the tags idiom like every other tag.
vim.opt.runtimepath:append(vim.env.FP_NVIM)
local render = require('flurryport.render')

local scratch = { at = '2026-08-17T18:00:00Z', id = 'scr1', byline = 'director', color = nil,
  channel = 'scratch', to = nil, text = 'thinking aloud, not an order', mine = true,
  verb = nil, re = nil, panic = false, status = nil, tags = {} }

local lines = render.event({ type = 'feed', item = scratch })
assert(lines[1].text:find('%(scratch%)'), 'the meta line wears the scratch mark: ' .. lines[1].text)
assert(lines[2].text:find('thinking aloud'), 'the body still renders beneath the meta line')

-- A struck post arrives with its mark in tags (engine-derived, #282): the
-- renderer already paints tags, so the mark rides with zero special casing.
local struck = { at = '2026-08-17T18:01:00Z', id = 'post1', byline = 'fable', color = 'red',
  channel = 'room', to = nil, text = 'the vault code is 1234', mine = false,
  verb = nil, re = nil, panic = false, status = nil, tags = { 'struck' } }
local struck_lines = render.event({ type = 'feed', item = struck })
assert(struck_lines[1].text:find('%[struck%]'), 'the struck tag rides the meta line: ' .. struck_lines[1].text)

print('SCRATCH OK')
