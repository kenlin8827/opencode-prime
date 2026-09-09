/**
 * Mirror of opencode's built-in TUI theme assets (MIT, anomalyco/opencode
 * packages/tui/src/theme/assets), pruned to the color keys the OCP
 * standalone host maps (defs kept whole so refs resolve). User theme files
 * in ~/.config/opencode/themes/ override this table exactly like opencode's
 * own hierarchy. Re-sync when OCP bumps its supported opencode version.
 */
export const BUILTIN_THEMES = {
  "ayu": {
    "defs": {
      "darkBg": "#0B0E14",
      "darkBgAlt": "#0D1017",
      "darkLine": "#11151C",
      "darkPanel": "#0F131A",
      "darkFg": "#BFBDB6",
      "darkFgMuted": "#565B66",
      "darkGutter": "#6C7380",
      "darkTag": "#39BAE6",
      "darkFunc": "#FFB454",
      "darkEntity": "#59C2FF",
      "darkString": "#AAD94C",
      "darkRegexp": "#95E6CB",
      "darkMarkup": "#F07178",
      "darkKeyword": "#FF8F40",
      "darkSpecial": "#E6B673",
      "darkComment": "#ACB6BF",
      "darkConstant": "#D2A6FF",
      "darkOperator": "#F29668",
      "darkAdded": "#7FD962",
      "darkRemoved": "#F26D78",
      "darkAccent": "#E6B450",
      "darkError": "#D95757",
      "darkIndentActive": "#6C7380"
    },
    "theme": {
      "primary": "darkEntity",
      "secondary": "darkConstant",
      "accent": "darkAccent",
      "error": "darkError",
      "warning": "darkSpecial",
      "text": "darkFg",
      "textMuted": "darkFgMuted",
      "background": "darkBg",
      "backgroundPanel": "darkPanel",
      "backgroundElement": "darkBgAlt",
      "border": "darkGutter",
      "borderActive": "darkIndentActive",
      "borderSubtle": "darkLine"
    }
  },
  "catppuccin-macchiato": {
    "defs": {
      "macRosewater": "#f4dbd6",
      "macFlamingo": "#f0c6c6",
      "macPink": "#f5bde6",
      "macMauve": "#c6a0f6",
      "macRed": "#ed8796",
      "macMaroon": "#ee99a0",
      "macPeach": "#f5a97f",
      "macYellow": "#eed49f",
      "macGreen": "#a6da95",
      "macTeal": "#8bd5ca",
      "macSky": "#91d7e3",
      "macSapphire": "#7dc4e4",
      "macBlue": "#8aadf4",
      "macLavender": "#b7bdf8",
      "macText": "#cad3f5",
      "macSubtext1": "#b8c0e0",
      "macSubtext0": "#a5adcb",
      "macOverlay2": "#939ab7",
      "macOverlay1": "#8087a2",
      "macOverlay0": "#6e738d",
      "macSurface2": "#5b6078",
      "macSurface1": "#494d64",
      "macSurface0": "#363a4f",
      "macBase": "#24273a",
      "macMantle": "#1e2030",
      "macCrust": "#181926"
    },
    "theme": {
      "primary": {
        "dark": "macBlue",
        "light": "macBlue"
      },
      "secondary": {
        "dark": "macMauve",
        "light": "macMauve"
      },
      "accent": {
        "dark": "macPink",
        "light": "macPink"
      },
      "error": {
        "dark": "macRed",
        "light": "macRed"
      },
      "warning": {
        "dark": "macYellow",
        "light": "macYellow"
      },
      "text": {
        "dark": "macText",
        "light": "macText"
      },
      "textMuted": {
        "dark": "macOverlay2",
        "light": "macOverlay2"
      },
      "background": {
        "dark": "macBase",
        "light": "macBase"
      },
      "backgroundPanel": {
        "dark": "macMantle",
        "light": "macMantle"
      },
      "backgroundElement": {
        "dark": "macCrust",
        "light": "macCrust"
      },
      "border": {
        "dark": "macSurface0",
        "light": "macSurface0"
      },
      "borderActive": {
        "dark": "macSurface1",
        "light": "macSurface1"
      },
      "borderSubtle": {
        "dark": "macSurface2",
        "light": "macSurface2"
      }
    }
  },
  "catppuccin": {
    "defs": {
      "lightRosewater": "#dc8a78",
      "lightFlamingo": "#dd7878",
      "lightPink": "#ea76cb",
      "lightMauve": "#8839ef",
      "lightRed": "#d20f39",
      "lightMaroon": "#e64553",
      "lightPeach": "#fe640b",
      "lightYellow": "#df8e1d",
      "lightGreen": "#40a02b",
      "lightTeal": "#179299",
      "lightSky": "#04a5e5",
      "lightSapphire": "#209fb5",
      "lightBlue": "#1e66f5",
      "lightLavender": "#7287fd",
      "lightText": "#4c4f69",
      "lightSubtext1": "#5c5f77",
      "lightSubtext0": "#6c6f85",
      "lightOverlay2": "#7c7f93",
      "lightOverlay1": "#8c8fa1",
      "lightOverlay0": "#9ca0b0",
      "lightSurface2": "#acb0be",
      "lightSurface1": "#bcc0cc",
      "lightSurface0": "#ccd0da",
      "lightBase": "#eff1f5",
      "lightMantle": "#e6e9ef",
      "lightCrust": "#dce0e8",
      "darkRosewater": "#f5e0dc",
      "darkFlamingo": "#f2cdcd",
      "darkPink": "#f5c2e7",
      "darkMauve": "#cba6f7",
      "darkRed": "#f38ba8",
      "darkMaroon": "#eba0ac",
      "darkPeach": "#fab387",
      "darkYellow": "#f9e2af",
      "darkGreen": "#a6e3a1",
      "darkTeal": "#94e2d5",
      "darkSky": "#89dceb",
      "darkSapphire": "#74c7ec",
      "darkBlue": "#89b4fa",
      "darkLavender": "#b4befe",
      "darkText": "#cdd6f4",
      "darkSubtext1": "#bac2de",
      "darkSubtext0": "#a6adc8",
      "darkOverlay2": "#9399b2",
      "darkOverlay1": "#7f849c",
      "darkOverlay0": "#6c7086",
      "darkSurface2": "#585b70",
      "darkSurface1": "#45475a",
      "darkSurface0": "#313244",
      "darkBase": "#1e1e2e",
      "darkMantle": "#181825",
      "darkCrust": "#11111b"
    },
    "theme": {
      "primary": {
        "dark": "darkBlue",
        "light": "lightBlue"
      },
      "secondary": {
        "dark": "darkMauve",
        "light": "lightMauve"
      },
      "accent": {
        "dark": "darkPink",
        "light": "lightPink"
      },
      "error": {
        "dark": "darkRed",
        "light": "lightRed"
      },
      "warning": {
        "dark": "darkYellow",
        "light": "lightYellow"
      },
      "text": {
        "dark": "darkText",
        "light": "lightText"
      },
      "textMuted": {
        "dark": "darkOverlay2",
        "light": "lightOverlay2"
      },
      "background": {
        "dark": "darkBase",
        "light": "lightBase"
      },
      "backgroundPanel": {
        "dark": "darkMantle",
        "light": "lightMantle"
      },
      "backgroundElement": {
        "dark": "darkCrust",
        "light": "lightCrust"
      },
      "border": {
        "dark": "darkSurface0",
        "light": "lightSurface0"
      },
      "borderActive": {
        "dark": "darkSurface1",
        "light": "lightSurface1"
      },
      "borderSubtle": {
        "dark": "darkSurface2",
        "light": "lightSurface2"
      }
    }
  },
  "dracula": {
    "defs": {
      "background": "#282a36",
      "currentLine": "#44475a",
      "selection": "#44475a",
      "foreground": "#f8f8f2",
      "comment": "#6272a4",
      "cyan": "#8be9fd",
      "green": "#50fa7b",
      "orange": "#ffb86c",
      "pink": "#ff79c6",
      "purple": "#bd93f9",
      "red": "#ff5555",
      "yellow": "#f1fa8c"
    },
    "theme": {
      "primary": {
        "dark": "purple",
        "light": "purple"
      },
      "secondary": {
        "dark": "pink",
        "light": "pink"
      },
      "accent": {
        "dark": "cyan",
        "light": "cyan"
      },
      "error": {
        "dark": "red",
        "light": "red"
      },
      "warning": {
        "dark": "yellow",
        "light": "yellow"
      },
      "text": {
        "dark": "foreground",
        "light": "#282a36"
      },
      "textMuted": {
        "dark": "comment",
        "light": "#6272a4"
      },
      "background": {
        "dark": "#282a36",
        "light": "#f8f8f2"
      },
      "backgroundPanel": {
        "dark": "#21222c",
        "light": "#e8e8e2"
      },
      "backgroundElement": {
        "dark": "currentLine",
        "light": "#d8d8d2"
      },
      "border": {
        "dark": "currentLine",
        "light": "#c8c8c2"
      },
      "borderActive": {
        "dark": "purple",
        "light": "purple"
      },
      "borderSubtle": {
        "dark": "#191a21",
        "light": "#e0e0e0"
      }
    }
  },
  "everforest": {
    "defs": {
      "darkStep1": "#2d353b",
      "darkStep2": "#333c43",
      "darkStep3": "#343f44",
      "darkStep4": "#3d484d",
      "darkStep5": "#475258",
      "darkStep6": "#7a8478",
      "darkStep7": "#859289",
      "darkStep8": "#9da9a0",
      "darkStep9": "#a7c080",
      "darkStep10": "#83c092",
      "darkStep11": "#7a8478",
      "darkStep12": "#d3c6aa",
      "darkRed": "#e67e80",
      "darkOrange": "#e69875",
      "darkGreen": "#a7c080",
      "darkCyan": "#83c092",
      "darkYellow": "#dbbc7f",
      "lightStep1": "#fdf6e3",
      "lightStep2": "#efebd4",
      "lightStep3": "#f4f0d9",
      "lightStep4": "#efebd4",
      "lightStep5": "#e6e2cc",
      "lightStep6": "#a6b0a0",
      "lightStep7": "#939f91",
      "lightStep8": "#829181",
      "lightStep9": "#8da101",
      "lightStep10": "#35a77c",
      "lightStep11": "#a6b0a0",
      "lightStep12": "#5c6a72",
      "lightRed": "#f85552",
      "lightOrange": "#f57d26",
      "lightGreen": "#8da101",
      "lightCyan": "#35a77c",
      "lightYellow": "#dfa000"
    },
    "theme": {
      "primary": {
        "dark": "darkStep9",
        "light": "lightStep9"
      },
      "secondary": {
        "dark": "#7fbbb3",
        "light": "#3a94c5"
      },
      "accent": {
        "dark": "#d699b6",
        "light": "#df69ba"
      },
      "error": {
        "dark": "darkRed",
        "light": "lightRed"
      },
      "warning": {
        "dark": "darkOrange",
        "light": "lightOrange"
      },
      "text": {
        "dark": "darkStep12",
        "light": "lightStep12"
      },
      "textMuted": {
        "dark": "darkStep11",
        "light": "lightStep11"
      },
      "background": {
        "dark": "darkStep1",
        "light": "lightStep1"
      },
      "backgroundPanel": {
        "dark": "darkStep2",
        "light": "lightStep2"
      },
      "backgroundElement": {
        "dark": "darkStep3",
        "light": "lightStep3"
      },
      "border": {
        "dark": "darkStep7",
        "light": "lightStep7"
      },
      "borderActive": {
        "dark": "darkStep8",
        "light": "lightStep8"
      },
      "borderSubtle": {
        "dark": "darkStep6",
        "light": "lightStep6"
      }
    }
  },
  "github": {
    "defs": {
      "darkBg": "#0d1117",
      "darkBgAlt": "#010409",
      "darkBgPanel": "#161b22",
      "darkFg": "#c9d1d9",
      "darkFgMuted": "#8b949e",
      "darkBlue": "#58a6ff",
      "darkGreen": "#3fb950",
      "darkRed": "#f85149",
      "darkOrange": "#d29922",
      "darkPurple": "#bc8cff",
      "darkPink": "#ff7b72",
      "darkYellow": "#e3b341",
      "darkCyan": "#39c5cf",
      "lightBg": "#ffffff",
      "lightBgAlt": "#f6f8fa",
      "lightBgPanel": "#f0f3f6",
      "lightFg": "#24292f",
      "lightFgMuted": "#57606a",
      "lightBlue": "#0969da",
      "lightGreen": "#1a7f37",
      "lightRed": "#cf222e",
      "lightOrange": "#bc4c00",
      "lightPurple": "#8250df",
      "lightPink": "#bf3989",
      "lightYellow": "#9a6700",
      "lightCyan": "#1b7c83"
    },
    "theme": {
      "primary": {
        "dark": "darkBlue",
        "light": "lightBlue"
      },
      "secondary": {
        "dark": "darkPurple",
        "light": "lightPurple"
      },
      "accent": {
        "dark": "darkCyan",
        "light": "lightCyan"
      },
      "error": {
        "dark": "darkRed",
        "light": "lightRed"
      },
      "warning": {
        "dark": "darkYellow",
        "light": "lightYellow"
      },
      "text": {
        "dark": "darkFg",
        "light": "lightFg"
      },
      "textMuted": {
        "dark": "darkFgMuted",
        "light": "lightFgMuted"
      },
      "background": {
        "dark": "darkBg",
        "light": "lightBg"
      },
      "backgroundPanel": {
        "dark": "darkBgAlt",
        "light": "lightBgAlt"
      },
      "backgroundElement": {
        "dark": "darkBgPanel",
        "light": "lightBgPanel"
      },
      "border": {
        "dark": "#30363d",
        "light": "#d0d7de"
      },
      "borderActive": {
        "dark": "darkBlue",
        "light": "lightBlue"
      },
      "borderSubtle": {
        "dark": "#21262d",
        "light": "#d8dee4"
      }
    }
  },
  "gruvbox": {
    "defs": {
      "darkBg0": "#282828",
      "darkBg1": "#3c3836",
      "darkBg2": "#504945",
      "darkBg3": "#665c54",
      "darkFg0": "#fbf1c7",
      "darkFg1": "#ebdbb2",
      "darkGray": "#928374",
      "darkRed": "#cc241d",
      "darkGreen": "#98971a",
      "darkYellow": "#d79921",
      "darkBlue": "#458588",
      "darkPurple": "#b16286",
      "darkAqua": "#689d6a",
      "darkOrange": "#d65d0e",
      "darkRedBright": "#fb4934",
      "darkGreenBright": "#b8bb26",
      "darkYellowBright": "#fabd2f",
      "darkBlueBright": "#83a598",
      "darkPurpleBright": "#d3869b",
      "darkAquaBright": "#8ec07c",
      "darkOrangeBright": "#fe8019",
      "lightBg0": "#fbf1c7",
      "lightBg1": "#ebdbb2",
      "lightBg2": "#d5c4a1",
      "lightBg3": "#bdae93",
      "lightFg0": "#282828",
      "lightFg1": "#3c3836",
      "lightGray": "#7c6f64",
      "lightRed": "#9d0006",
      "lightGreen": "#79740e",
      "lightYellow": "#b57614",
      "lightBlue": "#076678",
      "lightPurple": "#8f3f71",
      "lightAqua": "#427b58",
      "lightOrange": "#af3a03"
    },
    "theme": {
      "primary": {
        "dark": "darkBlueBright",
        "light": "lightBlue"
      },
      "secondary": {
        "dark": "darkPurpleBright",
        "light": "lightPurple"
      },
      "accent": {
        "dark": "darkAquaBright",
        "light": "lightAqua"
      },
      "error": {
        "dark": "darkRedBright",
        "light": "lightRed"
      },
      "warning": {
        "dark": "darkOrangeBright",
        "light": "lightOrange"
      },
      "text": {
        "dark": "darkFg1",
        "light": "lightFg1"
      },
      "textMuted": {
        "dark": "darkGray",
        "light": "lightGray"
      },
      "background": {
        "dark": "darkBg0",
        "light": "lightBg0"
      },
      "backgroundPanel": {
        "dark": "darkBg1",
        "light": "lightBg1"
      },
      "backgroundElement": {
        "dark": "darkBg2",
        "light": "lightBg2"
      },
      "border": {
        "dark": "darkBg3",
        "light": "lightBg3"
      },
      "borderActive": {
        "dark": "darkFg1",
        "light": "lightFg1"
      },
      "borderSubtle": {
        "dark": "darkBg2",
        "light": "lightBg2"
      }
    }
  },
  "kanagawa": {
    "defs": {
      "sumiInk0": "#1F1F28",
      "sumiInk1": "#2A2A37",
      "sumiInk2": "#363646",
      "sumiInk3": "#54546D",
      "fujiWhite": "#DCD7BA",
      "oldWhite": "#C8C093",
      "fujiGray": "#727169",
      "oniViolet": "#957FB8",
      "crystalBlue": "#7E9CD8",
      "carpYellow": "#C38D9D",
      "sakuraPink": "#D27E99",
      "waveAqua": "#76946A",
      "roninYellow": "#D7A657",
      "dragonRed": "#E82424",
      "lotusGreen": "#98BB6C",
      "waveBlue": "#2D4F67",
      "lightBg": "#F2E9DE",
      "lightPaper": "#EAE4D7",
      "lightText": "#54433A",
      "lightGray": "#9E9389"
    },
    "theme": {
      "primary": {
        "dark": "crystalBlue",
        "light": "waveBlue"
      },
      "secondary": {
        "dark": "oniViolet",
        "light": "oniViolet"
      },
      "accent": {
        "dark": "sakuraPink",
        "light": "sakuraPink"
      },
      "error": {
        "dark": "dragonRed",
        "light": "dragonRed"
      },
      "warning": {
        "dark": "roninYellow",
        "light": "roninYellow"
      },
      "text": {
        "dark": "fujiWhite",
        "light": "lightText"
      },
      "textMuted": {
        "dark": "fujiGray",
        "light": "lightGray"
      },
      "background": {
        "dark": "sumiInk0",
        "light": "lightBg"
      },
      "backgroundPanel": {
        "dark": "sumiInk1",
        "light": "lightPaper"
      },
      "backgroundElement": {
        "dark": "sumiInk2",
        "light": "#E3DCD2"
      },
      "border": {
        "dark": "sumiInk3",
        "light": "#D4CBBF"
      },
      "borderActive": {
        "dark": "carpYellow",
        "light": "carpYellow"
      },
      "borderSubtle": {
        "dark": "sumiInk2",
        "light": "#DCD4C9"
      }
    }
  },
  "matrix": {
    "defs": {
      "matrixInk0": "#0a0e0a",
      "matrixInk1": "#0e130d",
      "matrixInk2": "#141c12",
      "matrixInk3": "#1e2a1b",
      "rainGreen": "#2eff6a",
      "rainGreenDim": "#1cc24b",
      "rainGreenHi": "#62ff94",
      "rainCyan": "#00efff",
      "rainTeal": "#24f6d9",
      "rainPurple": "#c770ff",
      "rainOrange": "#ffa83d",
      "alertRed": "#ff4b4b",
      "alertYellow": "#e6ff57",
      "alertBlue": "#30b3ff",
      "rainGray": "#8ca391",
      "lightBg": "#eef3ea",
      "lightPaper": "#e4ebe1",
      "lightInk1": "#dae1d7",
      "lightText": "#203022",
      "lightGray": "#748476"
    },
    "theme": {
      "primary": {
        "dark": "rainGreen",
        "light": "rainGreenDim"
      },
      "secondary": {
        "dark": "rainCyan",
        "light": "rainTeal"
      },
      "accent": {
        "dark": "rainPurple",
        "light": "rainPurple"
      },
      "error": {
        "dark": "alertRed",
        "light": "alertRed"
      },
      "warning": {
        "dark": "alertYellow",
        "light": "alertYellow"
      },
      "text": {
        "dark": "rainGreenHi",
        "light": "lightText"
      },
      "textMuted": {
        "dark": "rainGray",
        "light": "lightGray"
      },
      "background": {
        "dark": "matrixInk0",
        "light": "lightBg"
      },
      "backgroundPanel": {
        "dark": "matrixInk1",
        "light": "lightPaper"
      },
      "backgroundElement": {
        "dark": "matrixInk2",
        "light": "lightInk1"
      },
      "border": {
        "dark": "matrixInk3",
        "light": "lightGray"
      },
      "borderActive": {
        "dark": "rainGreen",
        "light": "rainGreenDim"
      },
      "borderSubtle": {
        "dark": "matrixInk2",
        "light": "lightInk1"
      }
    }
  },
  "monokai": {
    "defs": {
      "background": "#272822",
      "backgroundAlt": "#1e1f1c",
      "backgroundPanel": "#3e3d32",
      "foreground": "#f8f8f2",
      "comment": "#75715e",
      "red": "#f92672",
      "orange": "#fd971f",
      "lightOrange": "#e69f66",
      "yellow": "#e6db74",
      "green": "#a6e22e",
      "cyan": "#66d9ef",
      "blue": "#66d9ef",
      "purple": "#ae81ff",
      "pink": "#f92672"
    },
    "theme": {
      "primary": {
        "dark": "cyan",
        "light": "blue"
      },
      "secondary": {
        "dark": "purple",
        "light": "purple"
      },
      "accent": {
        "dark": "green",
        "light": "green"
      },
      "error": {
        "dark": "red",
        "light": "red"
      },
      "warning": {
        "dark": "yellow",
        "light": "orange"
      },
      "text": {
        "dark": "foreground",
        "light": "#272822"
      },
      "textMuted": {
        "dark": "comment",
        "light": "#75715e"
      },
      "background": {
        "dark": "#272822",
        "light": "#fafafa"
      },
      "backgroundPanel": {
        "dark": "#1e1f1c",
        "light": "#f0f0f0"
      },
      "backgroundElement": {
        "dark": "#3e3d32",
        "light": "#e0e0e0"
      },
      "border": {
        "dark": "#3e3d32",
        "light": "#d0d0d0"
      },
      "borderActive": {
        "dark": "cyan",
        "light": "blue"
      },
      "borderSubtle": {
        "dark": "#1e1f1c",
        "light": "#e8e8e8"
      }
    }
  },
  "nord": {
    "defs": {
      "nord0": "#2E3440",
      "nord1": "#3B4252",
      "nord2": "#434C5E",
      "nord3": "#4C566A",
      "nord4": "#D8DEE9",
      "nord5": "#E5E9F0",
      "nord6": "#ECEFF4",
      "nord7": "#8FBCBB",
      "nord8": "#88C0D0",
      "nord9": "#81A1C1",
      "nord10": "#5E81AC",
      "nord11": "#BF616A",
      "nord12": "#D08770",
      "nord13": "#EBCB8B",
      "nord14": "#A3BE8C",
      "nord15": "#B48EAD"
    },
    "theme": {
      "primary": {
        "dark": "nord8",
        "light": "nord10"
      },
      "secondary": {
        "dark": "nord9",
        "light": "nord9"
      },
      "accent": {
        "dark": "nord7",
        "light": "nord7"
      },
      "error": {
        "dark": "nord11",
        "light": "nord11"
      },
      "warning": {
        "dark": "nord12",
        "light": "nord12"
      },
      "text": {
        "dark": "nord6",
        "light": "nord0"
      },
      "textMuted": {
        "dark": "#8B95A7",
        "light": "nord1"
      },
      "background": {
        "dark": "nord0",
        "light": "nord6"
      },
      "backgroundPanel": {
        "dark": "nord1",
        "light": "nord5"
      },
      "backgroundElement": {
        "dark": "nord2",
        "light": "nord4"
      },
      "border": {
        "dark": "nord2",
        "light": "nord3"
      },
      "borderActive": {
        "dark": "nord3",
        "light": "nord2"
      },
      "borderSubtle": {
        "dark": "nord2",
        "light": "nord3"
      }
    }
  },
  "one-dark": {
    "defs": {
      "darkBg": "#282c34",
      "darkBgAlt": "#21252b",
      "darkBgPanel": "#353b45",
      "darkFg": "#abb2bf",
      "darkFgMuted": "#5c6370",
      "darkPurple": "#c678dd",
      "darkBlue": "#61afef",
      "darkRed": "#e06c75",
      "darkGreen": "#98c379",
      "darkYellow": "#e5c07b",
      "darkOrange": "#d19a66",
      "darkCyan": "#56b6c2",
      "lightBg": "#fafafa",
      "lightBgAlt": "#f0f0f1",
      "lightBgPanel": "#eaeaeb",
      "lightFg": "#383a42",
      "lightFgMuted": "#a0a1a7",
      "lightPurple": "#a626a4",
      "lightBlue": "#4078f2",
      "lightRed": "#e45649",
      "lightGreen": "#50a14f",
      "lightYellow": "#c18401",
      "lightOrange": "#986801",
      "lightCyan": "#0184bc"
    },
    "theme": {
      "primary": {
        "dark": "darkBlue",
        "light": "lightBlue"
      },
      "secondary": {
        "dark": "darkPurple",
        "light": "lightPurple"
      },
      "accent": {
        "dark": "darkCyan",
        "light": "lightCyan"
      },
      "error": {
        "dark": "darkRed",
        "light": "lightRed"
      },
      "warning": {
        "dark": "darkYellow",
        "light": "lightYellow"
      },
      "text": {
        "dark": "darkFg",
        "light": "lightFg"
      },
      "textMuted": {
        "dark": "darkFgMuted",
        "light": "lightFgMuted"
      },
      "background": {
        "dark": "darkBg",
        "light": "lightBg"
      },
      "backgroundPanel": {
        "dark": "darkBgAlt",
        "light": "lightBgAlt"
      },
      "backgroundElement": {
        "dark": "darkBgPanel",
        "light": "lightBgPanel"
      },
      "border": {
        "dark": "#393f4a",
        "light": "#d1d1d2"
      },
      "borderActive": {
        "dark": "darkBlue",
        "light": "lightBlue"
      },
      "borderSubtle": {
        "dark": "#2c313a",
        "light": "#e0e0e1"
      }
    }
  },
  "opencode": {
    "defs": {
      "darkStep1": "#0a0a0a",
      "darkStep2": "#141414",
      "darkStep3": "#1e1e1e",
      "darkStep4": "#282828",
      "darkStep5": "#323232",
      "darkStep6": "#3c3c3c",
      "darkStep7": "#484848",
      "darkStep8": "#606060",
      "darkStep9": "#fab283",
      "darkStep10": "#ffc09f",
      "darkStep11": "#808080",
      "darkStep12": "#eeeeee",
      "darkSecondary": "#5c9cf5",
      "darkAccent": "#9d7cd8",
      "darkRed": "#e06c75",
      "darkOrange": "#f5a742",
      "darkGreen": "#7fd88f",
      "darkCyan": "#56b6c2",
      "darkYellow": "#e5c07b",
      "lightStep1": "#ffffff",
      "lightStep2": "#fafafa",
      "lightStep3": "#f5f5f5",
      "lightStep4": "#ebebeb",
      "lightStep5": "#e1e1e1",
      "lightStep6": "#d4d4d4",
      "lightStep7": "#b8b8b8",
      "lightStep8": "#a0a0a0",
      "lightStep9": "#3b7dd8",
      "lightStep10": "#2968c3",
      "lightStep11": "#8a8a8a",
      "lightStep12": "#1a1a1a",
      "lightSecondary": "#7b5bb6",
      "lightAccent": "#d68c27",
      "lightRed": "#d1383d",
      "lightOrange": "#d68c27",
      "lightGreen": "#3d9a57",
      "lightCyan": "#318795",
      "lightYellow": "#b0851f"
    },
    "theme": {
      "primary": {
        "dark": "darkStep9",
        "light": "lightStep9"
      },
      "secondary": {
        "dark": "darkSecondary",
        "light": "lightSecondary"
      },
      "accent": {
        "dark": "darkAccent",
        "light": "lightAccent"
      },
      "error": {
        "dark": "darkRed",
        "light": "lightRed"
      },
      "warning": {
        "dark": "darkOrange",
        "light": "lightOrange"
      },
      "text": {
        "dark": "darkStep12",
        "light": "lightStep12"
      },
      "textMuted": {
        "dark": "darkStep11",
        "light": "lightStep11"
      },
      "background": {
        "dark": "darkStep1",
        "light": "lightStep1"
      },
      "backgroundPanel": {
        "dark": "darkStep2",
        "light": "lightStep2"
      },
      "backgroundElement": {
        "dark": "darkStep3",
        "light": "lightStep3"
      },
      "border": {
        "dark": "darkStep7",
        "light": "lightStep7"
      },
      "borderActive": {
        "dark": "darkStep8",
        "light": "lightStep8"
      },
      "borderSubtle": {
        "dark": "darkStep6",
        "light": "lightStep6"
      }
    }
  },
  "solarized": {
    "defs": {
      "base03": "#002b36",
      "base02": "#073642",
      "base01": "#586e75",
      "base00": "#657b83",
      "base0": "#839496",
      "base1": "#93a1a1",
      "base2": "#eee8d5",
      "base3": "#fdf6e3",
      "yellow": "#b58900",
      "orange": "#cb4b16",
      "red": "#dc322f",
      "magenta": "#d33682",
      "violet": "#6c71c4",
      "blue": "#268bd2",
      "cyan": "#2aa198",
      "green": "#859900"
    },
    "theme": {
      "primary": {
        "dark": "blue",
        "light": "blue"
      },
      "secondary": {
        "dark": "violet",
        "light": "violet"
      },
      "accent": {
        "dark": "cyan",
        "light": "cyan"
      },
      "error": {
        "dark": "red",
        "light": "red"
      },
      "warning": {
        "dark": "yellow",
        "light": "yellow"
      },
      "text": {
        "dark": "base0",
        "light": "base00"
      },
      "textMuted": {
        "dark": "base01",
        "light": "base1"
      },
      "background": {
        "dark": "base03",
        "light": "base3"
      },
      "backgroundPanel": {
        "dark": "base02",
        "light": "base2"
      },
      "backgroundElement": {
        "dark": "#073642",
        "light": "#eee8d5"
      },
      "border": {
        "dark": "base02",
        "light": "base2"
      },
      "borderActive": {
        "dark": "base01",
        "light": "base1"
      },
      "borderSubtle": {
        "dark": "#073642",
        "light": "#eee8d5"
      }
    }
  },
  "tokyonight": {
    "defs": {
      "darkStep1": "#1a1b26",
      "darkStep2": "#1e2030",
      "darkStep3": "#222436",
      "darkStep4": "#292e42",
      "darkStep5": "#3b4261",
      "darkStep6": "#545c7e",
      "darkStep7": "#737aa2",
      "darkStep8": "#9099b2",
      "darkStep9": "#82aaff",
      "darkStep10": "#89b4fa",
      "darkStep11": "#828bb8",
      "darkStep12": "#c8d3f5",
      "darkRed": "#ff757f",
      "darkOrange": "#ff966c",
      "darkYellow": "#ffc777",
      "darkGreen": "#c3e88d",
      "darkCyan": "#86e1fc",
      "darkPurple": "#c099ff",
      "lightStep1": "#e1e2e7",
      "lightStep2": "#d5d6db",
      "lightStep3": "#c8c9ce",
      "lightStep4": "#b9bac1",
      "lightStep5": "#a8aecb",
      "lightStep6": "#9699a8",
      "lightStep7": "#737a8c",
      "lightStep8": "#5a607d",
      "lightStep9": "#2e7de9",
      "lightStep10": "#1a6ce7",
      "lightStep11": "#8990a3",
      "lightStep12": "#3760bf",
      "lightRed": "#f52a65",
      "lightOrange": "#b15c00",
      "lightYellow": "#8c6c3e",
      "lightGreen": "#587539",
      "lightCyan": "#007197",
      "lightPurple": "#9854f1"
    },
    "theme": {
      "primary": {
        "dark": "darkStep9",
        "light": "lightStep9"
      },
      "secondary": {
        "dark": "darkPurple",
        "light": "lightPurple"
      },
      "accent": {
        "dark": "darkOrange",
        "light": "lightOrange"
      },
      "error": {
        "dark": "darkRed",
        "light": "lightRed"
      },
      "warning": {
        "dark": "darkOrange",
        "light": "lightOrange"
      },
      "text": {
        "dark": "darkStep12",
        "light": "lightStep12"
      },
      "textMuted": {
        "dark": "darkStep11",
        "light": "lightStep11"
      },
      "background": {
        "dark": "darkStep1",
        "light": "lightStep1"
      },
      "backgroundPanel": {
        "dark": "darkStep2",
        "light": "lightStep2"
      },
      "backgroundElement": {
        "dark": "darkStep3",
        "light": "lightStep3"
      },
      "border": {
        "dark": "darkStep7",
        "light": "lightStep7"
      },
      "borderActive": {
        "dark": "darkStep8",
        "light": "lightStep8"
      },
      "borderSubtle": {
        "dark": "darkStep6",
        "light": "lightStep6"
      }
    }
  }
} as const
