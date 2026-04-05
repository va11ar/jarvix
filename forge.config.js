module.exports = {
  packagerConfig: {
    asar: {
      unpack: '**/QaMcpServer.js',
      unpackDir: '**/agent-samples'
    },
    ignore: [
      /^\/src/,
      /^\/\.git/,
      /^\/\.qwen/,
    ],
    win32metadata: {
      CompanyName: 'WAZEAR',
      FileDescription: 'Desktop application that orchestrates a pipeline of Qwen Code CLI agents',
      ProductName: 'WAZEAR',
      InternalName: 'WAZEAR',
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['linux', 'win32', 'darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          categories: ['Development'],
        },
      },
    },
  ],
};
