# cartridge/

This is the cartridge slot. Clone a cartridge from [team-agent-cartridges](https://github.com/anthonypark6904/team-agent-cartridges) here:

```sh
git clone https://github.com/anthonypark6904/team-agent-cartridges .
```

Or a specific cartridge only:

```sh
git clone --filter=blob:none --sparse https://github.com/anthonypark6904/team-agent-cartridges .
git sparse-checkout set kicad
```

After cloning, the active cartridge is loaded from `cartridge/<name>/`.
