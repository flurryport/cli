-- #258: prompt history. Up-arrow recalls submitted lines shell-style, newest
-- first; Down walks back; past the newest the in-progress draft returns.
vim.opt.runtimepath:append(vim.env.FP_NVIM)
local fp = require('flurryport')
local ui = require('flurryport.ui')
fp.setup({ presence_interval = 0 })

local submitted = {}
ui.open(function(line)
  table.insert(submitted, line)
end)

local prompt_buf = ui.buf.prompt

--- The typed half of the prompt line.
local function typed()
  local count = vim.api.nvim_buf_line_count(prompt_buf)
  local last = vim.api.nvim_buf_get_lines(prompt_buf, count - 1, count, false)[1] or ''
  return (last:gsub('^> ', ''))
end

--- Put text on the prompt line as if it were typed.
local function put(text)
  local count = vim.api.nvim_buf_line_count(prompt_buf)
  vim.api.nvim_buf_set_lines(prompt_buf, count - 1, count, false, { '> ' .. text })
end

--- Type a line into the prompt and hit enter, through the real keystroke path.
--- A leads in from normal mode; the x flag drains the typeahead synchronously.
local function submit(text)
  vim.api.nvim_set_current_win(ui.win.prompt)
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('A' .. text .. '<CR>', true, false, true), 'x', false)
end

-- 1. submitted lines reach the callback AND the history, oldest first
submit(':list projects')
submit('hello room')
assert(#submitted == 2 and submitted[2] == 'hello room', 'submission broke: ' .. #submitted)
assert(#ui.history == 2, 'history missed a line: ' .. #ui.history)
assert(ui.history[1] == ':list projects' and ui.history[2] == 'hello room', 'history order is off')

-- 2. empty lines and immediate repeats are not recorded
submit('')
submit('hello room')
assert(#ui.history == 2, 'an empty line or a repeat was recorded')

-- 3. Up recalls newest first; the walk stops at the oldest
ui.history_prev()
assert(typed() == 'hello room', 'first recall is not the newest: ' .. typed())
ui.history_prev()
assert(typed() == ':list projects', 'second recall is not the older line')
ui.history_prev()
assert(typed() == ':list projects', 'the walk fell off the oldest end')

-- 4. Down walks back; past the newest the draft returns
ui.history_next()
assert(typed() == 'hello room', 'Down did not walk back')
ui.history_next()
assert(typed() == '', 'past the newest should restore the (empty) draft: ' .. typed())

-- 5. a half-typed draft survives a recall round trip
put(':set foo')
ui.history_prev()
assert(typed() == 'hello room', 'recall over a draft failed')
ui.history_next()
assert(typed() == ':set foo', 'the draft did not come back: ' .. typed())

-- 6. typing resumes normally after a recall: the edited line submits and records
ui.history_prev()
vim.api.nvim_set_current_win(ui.win.prompt)
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('A again<CR>', true, false, true), 'x', false)
assert(submitted[#submitted] == 'hello room again', 'editing a recalled line broke: ' .. submitted[#submitted])
assert(ui.history[#ui.history] == 'hello room again', 'the edited submission was not recorded')

-- 7. the keys are wired on the prompt buffer, insert mode, buffer local
vim.api.nvim_set_current_win(ui.win.prompt)
assert(vim.fn.maparg('<Up>', 'i', false, true).buffer == 1, 'no buffer-local <Up> map')
assert(vim.fn.maparg('<Down>', 'i', false, true).buffer == 1, 'no buffer-local <Down> map')

print('HISTORY OK')
