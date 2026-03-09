module.exports = {
  packagerConfig: {
    asar: false,
    ignore: [
      /^\/src/,
      /^\/\.git/,
      /^\/\.qwen/,
    ],
    win32metadata: {
      CompanyName: 'JARVIX',
      FileDescription: 'Desktop application that orchestrates a pipeline of Qwen Code CLI agents',
      ProductName: 'JARVIX',
      InternalName: 'JARVIX',
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['linux', 'win32'],
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
