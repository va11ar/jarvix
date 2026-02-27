module.exports = {
  packagerConfig: {
    asar: true,
    ignore: [
      /^\/src/,
      /^\/\.git/,
      /^\/\.qwen/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['linux'],
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
