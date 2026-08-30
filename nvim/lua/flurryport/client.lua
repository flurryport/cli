-- The job half of the plugin: run `flurryport console --json`, decode the NDJSON
-- stream into ConsoleEvent tables, and write command lines back on stdin.
--
-- Everything this plugin knows about FlurryPORT arrives through here. There is no
-- HTTP, no auth, no room logic on the Lua side - the CLI already owns all of it,
-- and the contract is one JSON object per stdout line (see console-frontend.ts).

local M = {}

---@class fp.Client
---@field job integer|nil
---@field version string|nil
---@field carry string      partial trailing line between stdout chunks
---@field on_event fun(event: table)
---@field on_exit fun(code: integer)
local Client = {}
Client.__index = Client

--- nvim hands stdout in chunks that split anywhere, including mid-line and
--- mid-multibyte. The convention: the last element of `data` is a PARTIAL line
--- (possibly ""), so it is carried into the next chunk rather than parsed.
---@param chunk string[]
---@return string[] complete lines
function Client:_absorb(chunk)
  local lines = {}
  for i, piece in ipairs(chunk) do
    if i == 1 then
      self.carry = self.carry .. piece
    else
      table.insert(lines, self.carry)
      self.carry = piece
    end
  end
  return lines
end

---@param line string
function Client:_dispatch(line)
  if line == '' then
    return
  end
  -- luanil is not optional here. Without it JSON null decodes to vim.NIL, a
  -- USERDATA value that is truthy in Lua, so `if item.verb then` passes on every
  -- ordinary post and indexing it throws. The wire schema uses null for most
  -- optional members, so this is the difference between working and not.
  local ok, event = pcall(vim.json.decode, line, { luanil = { object = true, array = true } })
  if not ok or type(event) ~= 'table' or event.type == nil then
    -- A non-JSON line means the contract broke. Surface it rather than swallow
    -- it: silently dropping output is how a frontend ends up lying to its user.
    self.on_event({ type = 'error', text = 'unparsed console output: ' .. line })
    return
  end
  if event.type == 'hello' then
    self.version = event.version
  end
  self.on_event(event)
end

--- Send one command line to the console. Trailing newline is the delimiter the
--- CLI's readline is waiting on; without it the line is never seen.
---@param line string
---@return boolean sent
function Client:send(line)
  if not self.job then
    return false
  end
  vim.fn.chansend(self.job, line .. '\n')
  return true
end

--- Close stdin and let the console drain what it already accepted. The CLI treats
--- stdin ending as "no more input", not "abandon my work", so queued commands
--- still finish before the room comes down.
function Client:stop()
  if not self.job then
    return
  end
  self:send(':exit')
  self.job = nil
end

--- Kill the job outright. Only for a wedged console; :exit is the polite path.
function Client:kill()
  if self.job then
    vim.fn.jobstop(self.job)
    self.job = nil
  end
end

function Client:running()
  return self.job ~= nil
end

--- Resolve the launch command for this platform.
---
--- On Windows an npm global bin is a `.cmd` shim, and jobstart runs a list through
--- CreateProcess, which cannot execute one - it fails with "no such file or
--- directory" while `executable()` cheerfully reports 1, because it found the
--- extensionless shell shim beside it. Shims go through the command processor;
--- a real .exe is launched directly.
---@param cmd string[]
---@return string[] argv, string|nil err
local function resolve(cmd)
  local exe = cmd[1]
  local args = {}
  for i = 2, #cmd do
    table.insert(args, cmd[i])
  end

  if vim.fn.has('win32') ~= 1 then
    if vim.fn.executable(exe) == 0 then
      return cmd, ('%s is not on PATH. Install it, or set cmd in setup().'):format(exe)
    end
    return cmd, nil
  end

  local found
  for _, candidate in ipairs({ exe .. '.exe', exe .. '.cmd', exe .. '.bat', exe }) do
    local path = vim.fn.exepath(candidate)
    if path ~= '' then
      found = path
      break
    end
  end
  if not found then
    return cmd, ('%s is not on PATH. Install it, or set cmd in setup().'):format(exe)
  end
  if found:lower():match('%.exe$') then
    return vim.list_extend({ found }, args), nil
  end
  return vim.list_extend({ 'cmd.exe', '/c', found }, args), nil
end

---@param opts { cmd?: string[], cwd?: string, on_event: fun(event: table), on_exit: fun(code: integer) }
---@return fp.Client|nil client, string|nil err
function M.start(opts)
  local self = setmetatable({
    job = nil,
    version = nil,
    carry = '',
    on_event = opts.on_event,
    on_exit = opts.on_exit,
  }, Client)

  local argv, err = resolve(opts.cmd or { 'flurryport', 'console', '--json' })
  if err then
    return nil, err
  end

  local job = vim.fn.jobstart(argv, {
    cwd = opts.cwd,
    stdout_buffered = false,
    stderr_buffered = false,
    on_stdout = function(_, data)
      if not data then
        return
      end
      for _, line in ipairs(self:_absorb(data)) do
        self:_dispatch(line)
      end
    end,
    on_stderr = function(_, data)
      if not data then
        return
      end
      for _, line in ipairs(data) do
        if line ~= '' then
          self.on_event({ type = 'error', text = line })
        end
      end
    end,
    on_exit = function(_, code)
      self.job = nil
      self.on_exit(code)
    end,
  })

  if job <= 0 then
    return nil, ('could not start %s (jobstart returned %d)'):format(table.concat(argv, ' '), job)
  end
  self.job = job
  return self, nil
end

return M
