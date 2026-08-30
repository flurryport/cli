-- flurryport.nvim - the room, in the editor.
--
-- The CLI owns every decision (parsing, auth, the room, the wire schema); this
-- plugin owns presentation and navigation. It speaks one protocol: NDJSON
-- ConsoleEvents in, bare command lines out. If something is wrong with what the
-- room DOES, fix the CLI; if something is wrong with how it LOOKS or how you move
-- through it, fix this.

local client = require('flurryport.client')
local complete = require('flurryport.complete')
local render = require('flurryport.render')
local ui = require('flurryport.ui')

local M = {}

---@class fp.Config
---@field cmd string[]             how to launch the console
---@field presence_interval number seconds between roster refreshes; 0 disables
---@field lowercase_alias string|false type this in lowercase; false to skip
---@field command string           the top-level command name; rename on collision
M.config = {
  cmd = { 'flurryport', 'console', '--json' },
  presence_interval = 15,
  -- ONE command, in the product's own casing. A cryptic short name buys nothing:
  -- vim accepts any UNAMBIGUOUS PREFIX of a user command, so this is typed ":Fl"
  -- - as few keystrokes as ":Fp" - while reading as the brand everywhere it is
  -- shown. The casing is free for the same reason: nobody types it in full, and
  -- the wrong casing (:FlurryPort) fails loudly rather than doing something else.
  -- If another plugin ever claims Fl, vim answers E464 and you type one more
  -- letter; a loud collision beats a silent one.
  command = 'FlurryPORT',
  -- Vim REFUSES lowercase user commands outright - that space belongs to builtins
  -- ("Invalid command name (must start with uppercase)"). A guarded cmdline
  -- abbreviation can expand a lowercase word anyway; off by default because prefix
  -- typing already makes this fast and an abbreviation touches global cmdline state.
  lowercase_alias = false,
  -- Post bodies in the poster's seat colour, not just the byline. ON by default
  -- (ruled 08-16, #269): looking at the live room settled it. :FlurryPORT bodies
  -- flips it live and repaints, so the quieter read is one toggle away.
  color_bodies = true,
}

---@type fp.Client|nil
local session = nil
local timer = nil
local bound = false

--- roster rows and status rows carry different shapes; the presence strip takes
--- one. Derive the same words the console shows: the invite status, held, then
--- presence truth (#266: live / idle / adrift / departed) when the engine sends
--- it, then the pre-#266 live/idle fallback.
---@param event table
---@return table[]
local function presence_rows(event)
  local rows = {}
  if event.type == 'status' then
    for _, r in ipairs(event.rows or {}) do
      table.insert(rows, { handle = r.handle, state = r.state, posts = r.posts, color = r.color })
    end
    return rows
  end
  for _, r in ipairs(event.rows or {}) do
    -- JSON null decodes to vim.NIL, which is TRUTHY in Lua: normalize first, or
    -- a presence-less row would render the word "userdata".
    local presence = r.presence
    if presence == vim.NIL then
      presence = nil
    end
    local state
    if r.status ~= 'accepted' then
      state = r.status
    elseif r.held then
      state = 'held' -- held overlays transport truth, exactly as the console does
    elseif presence then
      state = presence
    elseif r.live then
      state = 'live'
    else
      state = 'idle'
    end
    table.insert(rows, { handle = r.handle, state = state, color = r.color, greyed = (r.greyed == true) })
  end
  return rows
end

local function stop_timer()
  if timer then
    timer:stop()
    timer:close()
    timer = nil
  end
end

--- Ask the room who is at the table. The console answers with a roster event,
--- which never reaches the feed buffer - it repaints the presence strip instead.
local function refresh_presence()
  if session and session:running() and bound then
    session:send(':list seats')
  end
end

local function start_timer()
  stop_timer()
  if M.config.presence_interval <= 0 then
    return
  end
  timer = vim.uv.new_timer()
  timer:start(
    M.config.presence_interval * 1000,
    M.config.presence_interval * 1000,
    vim.schedule_wrap(refresh_presence)
  )
end

--- The event sink for the console job. Public so the headless suite can drive it
--- without spawning a console.
---@param event table
function M.handle_event(event)
  -- The completion cache sees everything first (#257). An answer to a QUIET
  -- fetch is consumed here: cached for <Tab>, never painted into the feed.
  local consumed = complete.note_event(event)
  if event.type == 'roster' or event.type == 'status' then
    ui.set_presence(presence_rows(event))
    return
  end
  -- The decision ledger (#295) is panel state exactly like the roster: it
  -- repaints the decisions section and never reaches the feed buffer.
  if event.type == 'decisions' then
    ui.set_decisions(event.rows or {})
    return
  end
  -- Binding is what makes the feed and the roster meaningful; the console says so
  -- in an info line, which is also the moment presence is worth polling.
  if event.type == 'info' and event.text and event.text:match('^Bound to ') then
    bound = true
    vim.schedule(refresh_presence)
  end
  if consumed or event.type == 'exit' then
    return
  end
  ui.push(event)
end

---@param code integer
local function on_exit(code)
  stop_timer()
  bound = false
  session = nil
  -- Take the prompt away FIRST: a prompt over a dead console accepts line after
  -- line and answers none of them, which is exactly how this was found.
  ui.orphan()
  ui.push({
    type = 'info',
    text = ('console exited (%d). q or :%s close closes this; :%s starts a new one.')
      :format(code, M.config.command, M.config.command),
  })
end

--- Send one line to the console exactly as typed at its own prompt. Bare text
--- posts to the room; a leading ':' steers. The plugin adds no grammar of its own.
---@param line string
function M.send(line)
  if not session or not session:running() then
    ui.push({ type = 'error', text = ('no console running - :%s to start one'):format(M.config.command) })
    return
  end
  session:send(line)
end

--- <Tab> in the prompt (#257): complete :set arguments and seat handles. A
--- literal tab stays reachable as <C-v><Tab>. With the menu up, <Tab> cycles.
function M.prompt_complete()
  if vim.fn.pumvisible() == 1 then
    vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<C-n>', true, false, true), 'n', false)
    return
  end
  local buf = ui.buf.prompt
  if not buf or not vim.api.nvim_buf_is_valid(buf) or vim.api.nvim_get_current_buf() ~= buf then
    return
  end
  local prompt = vim.fn.prompt_getprompt(buf)
  local line = vim.api.nvim_get_current_line()
  local col = vim.api.nvim_win_get_cursor(0)[2]
  local typed = line:sub(#prompt + 1, col)
  local found = complete.candidates(typed)
  if found and #found.matches > 0 then
    vim.fn.complete(#prompt + found.start + 1, found.matches)
    return
  end
  -- Nothing to offer. If a :set line wanted room lists the cache does not have,
  -- fetch them QUIETLY: cached on arrival, consumed before the feed can paint
  -- them, so the next <Tab> completes without the room ever seeing the fetch.
  if complete.is_set_context(typed) and session and session:running() then
    for _, fetch in ipairs(complete.fetch_lines()) do
      session:send(fetch)
    end
  end
end

--- Wire the completion key onto the prompt buffer. Split out so the headless
--- suite can attach it without spawning a console.
---@param buf integer
function M.attach_completion(buf)
  vim.keymap.set('i', '<Tab>', M.prompt_complete, {
    buffer = buf,
    desc = 'complete :set arguments and seat handles (<C-v><Tab> for a literal tab)',
  })
end

function M.open()
  if session and session:running() then
    vim.notify('flurryport: console already running', vim.log.levels.INFO)
    return
  end
  complete.reset()
  ui.open(function(line)
    if line and line ~= '' then
      M.send(line)
    end
  end)
  M.attach_completion(ui.buf.prompt)
  local c, err = client.start({
    cmd = M.config.cmd,
    on_event = vim.schedule_wrap(M.handle_event),
    on_exit = vim.schedule_wrap(on_exit),
  })
  if not c then
    ui.push({ type = 'error', text = err or 'could not start the console' })
    return
  end
  session = c
  start_timer()
end

function M.close()
  stop_timer()
  if session then
    session:stop() -- :exit, so the room comes down with the console (#253)
    session = nil
  end
  bound = false
  ui.close()
end

--- Handles currently at the table, for command completion.
---@return string[]
local function known_bylines()
  local seen, out = {}, {}
  for _, item in ipairs(ui.items) do
    local b = item.byline
    if b and not seen[b] then
      seen[b] = true
      table.insert(out, b)
    end
  end
  return out
end

---@param opts table|nil
function M.setup(opts)
  M.config = vim.tbl_deep_extend('force', M.config, opts or {})

  -- Groups exist from setup on, so :highlight FlurryPortInfo ... in a config works
  -- before the room is ever opened; re-applied on ColorScheme because a scheme
  -- switch clears them, default links included.
  render.color_bodies = M.config.color_bodies
  ui.apply_highlights()
  vim.api.nvim_create_autocmd('ColorScheme', {
    group = vim.api.nvim_create_augroup('FlurryPortHighlights', { clear = true }),
    callback = function() ui.apply_highlights() end,
    desc = 'reapply FlurryPORT highlight groups',
  })

  -- ONE command, subcommands beneath it (the :Lazy / :Telescope shape). Keeps the
  -- global command namespace to a single name and makes the whole surface
  -- tab-discoverable instead of something to memorize.
  local subs = {
    open = { run = function() M.open() end, desc = 'open the room and start the console' },
    close = { run = function() M.close() end, desc = 'exit the console and close the tab' },
    feed = { run = function() ui.show_feed() end, desc = 'back to the live feed' },
    bodies = {
      desc = 'toggle post bodies carrying the seat colour',
      run = function()
        render.color_bodies = not render.color_bodies
        ui.repaint()
        vim.notify(('flurryport: coloured post bodies %s')
          :format(render.color_bodies and 'on' or 'off'), vim.log.levels.INFO)
      end,
    },
    pass = {
      desc = 'yank the latest boarding pass (clipboard + unnamed register)',
      run = function()
        local code = ui.yank_pass()
        if code then
          vim.notify(('flurryport: boarding pass %s yanked'):format(code), vim.log.levels.INFO)
        else
          vim.notify('flurryport: no boarding pass yet - :seat <name> in the prompt', vim.log.levels.WARN)
        end
      end,
    },
    presence = { run = refresh_presence, desc = 'refresh the presence strip now' },
    say = {
      run = function(rest) M.send(rest) end,
      desc = 'send one line (bare text posts; : steers)',
    },
    envoy = {
      run = function(rest) ui.open_envoy(rest) end,
      desc = 'show one envoy\'s posts in the feed window',
      complete = known_bylines,
    },
  }

  local name = M.config.command
  -- Refuse to clobber somebody else's command. The check is best-effort by
  -- nature: if they load AFTER us they will overwrite us just as silently, and
  -- nvim gives no hook for that. Loud in the case we can see beats loud in none.
  local taken = vim.api.nvim_get_commands({})[name] ~= nil
  if taken then
    -- Never clobber. create_user_command overwrites silently, so the only way a
    -- clash is survivable is to notice it and say so.
    vim.notify(
      ('flurryport: :%s is already taken by another plugin. Set command = "..." in setup().'):format(name),
      vim.log.levels.WARN
    )
  else
    vim.api.nvim_create_user_command(name, function(a)
    local sub_name, rest = a.args:match('^(%S+)%s*(.*)$')
    -- A bare call opens the room, because that is what you want nine times in ten.
    if not sub_name then
      M.open()
      return
    end
    local sub = subs[sub_name]
    if not sub then
      vim.notify(
        ('flurryport: no subcommand %q (try :%s <Tab>)'):format(sub_name, name),
        vim.log.levels.ERROR
      )
      return
    end
    sub.run(rest)
  end, {
    nargs = '*',
    desc = 'FlurryPORT room',
    complete = function(lead, line)
      -- Second word onward completes through the subcommand, not the list.
      local typed = line:match('^%s*' .. vim.pesc(name) .. '%s+(%S+)%s')
      if typed then
        local sub = subs[typed]
        if sub and sub.complete then
          return vim.tbl_filter(function(c)
            return c:lower():find(lead:lower(), 1, true) == 1
          end, sub.complete())
        end
        return {}
      end
      return vim.tbl_filter(function(sub_name)
        return sub_name:find(lead, 1, true) == 1
      end, vim.tbl_keys(subs))
    end,
    })
  end

  -- Type it lowercase. The guard matters: an unguarded abbreviation would fire on
  -- the word ANYWHERE in a command line, so it expands only when it is the entire
  -- line so far - never inside :s///, never as somebody else's argument.
  local alias = M.config.lowercase_alias
  if alias and alias ~= '' and not taken then
    vim.cmd(([[cnoreabbrev <expr> %s (getcmdtype() == ':' && getcmdline() ==# '%s') ? '%s' : '%s']])
      :format(alias, alias, name, alias))
  end
end

return M
