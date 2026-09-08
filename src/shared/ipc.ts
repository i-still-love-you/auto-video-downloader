// IPC 채널 이름 상수. 메인/프리로드 양쪽에서 동일하게 사용한다.
export const IPC = {
  browser: {
    getState: 'browser:getState',
    newTab: 'browser:newTab',
    closeTab: 'browser:closeTab',
    activateTab: 'browser:activateTab',
    navigate: 'browser:navigate',
    goBack: 'browser:goBack',
    goForward: 'browser:goForward',
    reload: 'browser:reload',
    stop: 'browser:stop',
    setBounds: 'browser:setBounds',
    setVisible: 'browser:setVisible',
    getDetected: 'browser:getDetected',
    clearDetected: 'browser:clearDetected',
    evState: 'browser:ev:state',
    evDetected: 'browser:ev:detected'
  },
  history: {
    list: 'history:list',
    remove: 'history:remove',
    clear: 'history:clear'
  },
  bookmarks: {
    list: 'bookmarks:list',
    add: 'bookmarks:add',
    remove: 'bookmarks:remove'
  },
  downloads: {
    list: 'downloads:list',
    analyze: 'downloads:analyze',
    analyzeDetected: 'downloads:analyzeDetected',
    getLog: 'downloads:getLog',
    enqueue: 'downloads:enqueue',
    pause: 'downloads:pause',
    resume: 'downloads:resume',
    cancel: 'downloads:cancel',
    retry: 'downloads:retry',
    remove: 'downloads:remove',
    clearFinished: 'downloads:clearFinished',
    openFile: 'downloads:openFile',
    showInFolder: 'downloads:showInFolder',
    evUpdate: 'downloads:ev:update',
    evRemoved: 'downloads:ev:removed'
  },
  files: {
    list: 'files:list',
    open: 'files:open',
    showInFolder: 'files:showInFolder',
    remove: 'files:remove',
    rename: 'files:rename',
    mediaUrl: 'files:mediaUrl',
    pickFiles: 'files:pickFiles'
  },
  player: {
    proxyUrl: 'player:proxyUrl'
  },
  vault: {
    state: 'vault:state',
    setup: 'vault:setup',
    unlock: 'vault:unlock',
    lock: 'vault:lock',
    add: 'vault:add',
    remove: 'vault:remove',
    open: 'vault:open',
    export: 'vault:export',
    changePin: 'vault:changePin'
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
    chooseDir: 'settings:chooseDir'
  },
  tools: {
    status: 'tools:status',
    install: 'tools:install',
    evProgress: 'tools:ev:progress'
  },
  app: {
    version: 'app:version',
    openExternal: 'app:openExternal',
    checkUpdate: 'app:checkUpdate',
    installUpdate: 'app:installUpdate',
    updateStatus: 'app:updateStatus',
    evNotify: 'app:ev:notify',
    evUpdate: 'app:ev:update',
    evNavigate: 'app:ev:navigate'
  }
} as const
