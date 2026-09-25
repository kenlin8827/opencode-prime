#!/usr/bin/env python3
"""
Generate the 6 missing install locales (es, fr, ru, ar, pt, ja) from en.json.

Each generated file:
  - keeps en.json's full structure (so every string has an English fallback
    value; missing keys fall through to English automatically via the
    `{ ...FALLBACK_EN, ...raw }` merge in loadLocale);
  - overrides the `_meta` block with locale-native name + hint;
  - overrides the `toolLabels`, `mcpLabels`, `pluginLabels` blocks with
    locale-native labels (the user-visible tool names that the dashboard
    shows in the Tools/MCP/Plugins tabs).

This is a one-time seed. Maintainers can add real translations for the
other 110+ keys at any pace; until they do, the dashboard shows English
for those entries.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EN = ROOT / "install" / "locales" / "en.json"
OUT = ROOT / "install" / "locales"

# ---------------------------------------------------------------------------
# Tool labels (label + hint) translated for the 6 locales.
# Each entry matches the schema of en.json's `toolLabels.<key> = {label, hint}`.
# The label is the user-visible tool name in the dashboard; the hint is the
# short description that appears under the label.
# ---------------------------------------------------------------------------
TOOLS = {
    "es": {
        "rtk":                 {"label": "RTK Tokenizer",            "hint": "Proxy y plugin de Rust Token Killer"},
        "ripgrep":             {"label": "ripgrep (rg)",              "hint": "Buscador grep rápido con .gitignore (BurntSushi/ripgrep); backend preferido por el agente."},
        "tgrep":               {"label": "Índice tgrep",              "hint": "Búsqueda full-text indexada por trigramas (microsoft/tgrep); acelera la búsqueda en repos grandes."},
        "openchamber_web":     {"label": "OpenChamber Web",          "hint": "Instala la CLI web de OpenChamber para `ocp web` (necesita Node.js 22+)"},
        "openchamber_desktop": {"label": "OpenChamber Desktop",      "hint": "App de escritorio nativa para `ocp desktop` / `ocp ui` — descarga aparte (https://openchamber.dev/download); la instalación sólo verifica presencia."},
        "openchamber_vscode":  {"label": "OpenChamber VS Code",      "hint": "Extensión del editor para `ocp code` — instala fedaykindev.openchamber por CLI si falta."},
        "herdr":               {"label": "Herdr",                    "hint": "Gestor de workspaces de terminal para agentes de IA (https://herdr.dev) — `ocp herdr` abre el dir actual."},
        "opencode":            {"label": "OpenCode",                 "hint": "Agente de IA — motor de `ocp tui`"},
    },
    "fr": {
        "rtk":                 {"label": "RTK Tokenizer",            "hint": "Proxy et plugin Rust Token Killer"},
        "ripgrep":             {"label": "ripgrep (rg)",              "hint": "Outil grep rapide respectant .gitignore (BurntSushi/ripgrep); backend par défaut de l'agent."},
        "tgrep":               {"label": "Index tgrep",              "hint": "Recherche full-text indexée par trigrammes (microsoft/tgrep); accélère la recherche dans les grands dépôts."},
        "openchamber_web":     {"label": "OpenChamber Web",          "hint": "Installe la CLI web OpenChamber pour `ocp web` (Node.js 22+ requis)"},
        "openchamber_desktop": {"label": "OpenChamber Desktop",      "hint": "App bureau native pour `ocp desktop` / `ocp ui` — téléchargement séparé (https://openchamber.dev/download); l'install vérifie seulement la présence."},
        "openchamber_vscode":  {"label": "OpenChamber VS Code",      "hint": "Extension d'éditeur pour `ocp code` — installe fedaykindev.openchamber via la CLI de l'éditeur si absente."},
        "herdr":               {"label": "Herdr",                    "hint": "Gestionnaire de workspaces terminal pour agents IA (https://herdr.dev) — `ocp herdr` ouvre le dossier courant."},
        "opencode":            {"label": "OpenCode",                 "hint": "Agent de codage IA — moteur de `ocp tui`"},
    },
    "ru": {
        "rtk":                 {"label": "RTK Tokenizer",            "hint": "Прокси и плагин Rust Token Killer"},
        "ripgrep":             {"label": "ripgrep (rg)",              "hint": "Быстрый grep с поддержкой .gitignore (BurntSushi/ripgrep); предпочтительный бэкенд для агента."},
        "tgrep":               {"label": "Индекс tgrep",             "hint": "Полнотекстовый поиск по триграммам (microsoft/tgrep); ускоряет поиск в больших репозиториях."},
        "openchamber_web":     {"label": "OpenChamber Web",          "hint": "Установить веб-CLI OpenChamber для `ocp web` (требуется Node.js 22+)"},
        "openchamber_desktop": {"label": "OpenChamber Desktop",      "hint": "Нативное десктоп-приложение для `ocp desktop` / `ocp ui` — отдельная загрузка (https://openchamber.dev/download); установка только проверяет наличие."},
        "openchamber_vscode":  {"label": "OpenChamber VS Code",      "hint": "Расширение редактора для `ocp code` — автоустановка fedaykindev.openchamber через CLI редактора."},
        "herdr":               {"label": "Herdr",                    "hint": "Менеджер терминальных рабочих пространств для ИИ-агентов (https://herdr.dev) — `ocp herdr` открывает текущую папку."},
        "opencode":            {"label": "OpenCode",                 "hint": "ИИ-агент кодинга — основа `ocp tui`"},
    },
    "ar": {
        "rtk":                 {"label": "RTK Tokenizer",            "hint": "وكيل ومكون Rust Token Killer الإضافي"},
        "ripgrep":             {"label": "ripgrep (rg)",              "hint": "أداة grep سريعة تحترم .gitignore (BurntSushi/ripgrep)؛ الواجهة الافتراضية للوكيل."},
        "tgrep":               {"label": "فهرس tgrep",              "hint": "بحث نصي كامل مفهرس بالثلاثيات (microsoft/tgrep)؛ يسرّع البحث في المستودعات الكبيرة."},
        "openchamber_web":     {"label": "OpenChamber Web",          "hint": "ثبّت واجهة سطر أوامر OpenChamber للويب لـ `ocp web` (يحتاج Node.js 22+)"},
        "openchamber_desktop": {"label": "OpenChamber Desktop",      "hint": "تطبيق سطح مكتب أصيل لـ `ocp desktop` / `ocp ui` — تنزيل منفصل (https://openchamber.dev/download)؛ التحقق من التثبيت فقط."},
        "openchamber_vscode":  {"label": "OpenChamber VS Code",      "hint": "إضافة المحرر لـ `ocp code` — تثبيت تلقائي لـ fedaykindev.openchamber عبر CLI المحرر عند الغياب."},
        "herdr":               {"label": "Herdr",                    "hint": "مدير مساحات عمل طرفية لوكلاء الذكاء الاصطناعي (https://herdr.dev) — `ocp herdr` يفتح المجلد الحالي."},
        "opencode":            {"label": "OpenCode",                 "hint": "وكيل برمجة ذكاء اصطناعي — محرك `ocp tui`"},
    },
    "pt": {
        "rtk":                 {"label": "RTK Tokenizer",            "hint": "Proxy e plugin Rust Token Killer"},
        "ripgrep":             {"label": "ripgrep (rg)",              "hint": "Buscador grep rápido ciente de .gitignore (BurntSushi/ripgrep); backend preferido pelo agente."},
        "tgrep":               {"label": "Índice tgrep",              "hint": "Busca full-text indexada por trigramas (microsoft/tgrep); acelera buscas em repos grandes."},
        "openchamber_web":     {"label": "OpenChamber Web",          "hint": "Instala a CLI web do OpenChamber para `ocp web` (precisa Node.js 22+)"},
        "openchamber_desktop": {"label": "OpenChamber Desktop",      "hint": "App desktop nativo para `ocp desktop` / `ocp ui` — download separado (https://openchamber.dev/download); a instalação só checa presença."},
        "openchamber_vscode":  {"label": "OpenChamber VS Code",      "hint": "Extensão do editor para `ocp code` — instala fedaykindev.openchamber via CLI do editor se ausente."},
        "herdr":               {"label": "Herdr",                    "hint": "Gerenciador de workspaces de terminal para agentes de IA (https://herdr.dev) — `ocp herdr` abre o diretório atual."},
        "opencode":            {"label": "OpenCode",                 "hint": "Agente de codificação IA — motor do `ocp tui`"},
    },
    "ja": {
        "rtk":                 {"label": "RTK トークナイザー",       "hint": "Rust Token Killer プロキシ兼プラグイン"},
        "ripgrep":             {"label": "ripgrep (rg)",              "hint": ".gitignore を尊重する高速 grep (BurntSushi/ripgrep); エージェント既定の検索バックエンド。"},
        "tgrep":               {"label": "tgrep 検索インデックス",    "hint": "トライグラム索引による高性能全文検索 (microsoft/tgrep); 大規模リポジトリの検索を大幅に高速化。"},
        "openchamber_web":     {"label": "OpenChamber Web",          "hint": "`ocp web` 用 OpenChamber Web CLI をインストール (Node.js 22+ が必要)"},
        "openchamber_desktop": {"label": "OpenChamber Desktop",      "hint": "`ocp desktop` / `ocp ui` 用ネイティブデスクトップアプリ — 別途ダウンロード (https://openchamber.dev/download); インストールは有無のみ。"},
        "herdr":               {"label": "Herdr",                    "hint": "AI コーディングエージェント向けターミナルワークスペース管理 (https://herdr.dev) — `ocp herdr` で現在のディレクトリを開く。"},
        "opencode":            {"label": "OpenCode",                 "hint": "AI コーディングエージェント — `ocp tui` のエンジン"},
    },
}

MCPS = {
    "es": {
        "serena":    {"label": "Serena",          "hint": "Navegación y edición semántica de código a través de su servidor MCP."},
        "codegraph": {"label": "CodeGraph",       "hint": "Análisis de relaciones del repositorio; ejecuta `codegraph init` una vez por proyecto."},
        "gitnexus":  {"label": "GitNexus",        "hint": "Integración de inteligencia del repositorio; actívalo sólo cuando esté licenciado e indexado."},
        "dbhub":     {"label": "DBHub",           "hint": "Pasarela de base de datos; requiere `dbhub.toml` y DSN en el proyecto."},
        "headroom":  {"label": "Headroom",        "hint": "MCP de compresión local; su primera ejecución descarga un runtime y un modelo."},
        "idea":      {"label": "JetBrains IDEA",  "hint": "Integración MCP de JetBrains IDE; habilita primero el servidor en el IDE."},
    },
    "fr": {
        "serena":    {"label": "Serena",          "hint": "Navigation et édition sémantique du code via son serveur MCP."},
        "codegraph": {"label": "CodeGraph",       "hint": "Analyse des relations du dépôt ; exécute `codegraph init` une fois par projet."},
        "gitnexus":  {"label": "GitNexus",        "hint": "Intelligence du dépôt ; active uniquement si tu as la licence et l'indexation."},
        "dbhub":     {"label": "DBHub",           "hint": "Passerelle base de données ; nécessite `dbhub.toml` et DSN dans le projet."},
        "headroom":  {"label": "Headroom",        "hint": "MCP de compression locale ; le premier lancement télécharge un runtime et un modèle."},
        "idea":      {"label": "JetBrains IDEA",  "hint": "Intégration MCP JetBrains IDE ; active d'abord le serveur dans l'IDE."},
    },
    "ru": {
        "serena":    {"label": "Serena",          "hint": "Семантическая навигация и редактирование кода через свой MCP-сервер."},
        "codegraph": {"label": "CodeGraph",       "hint": "Анализ связей в репозитории; выполните `codegraph init` один раз для проекта."},
        "gitnexus":  {"label": "GitNexus",        "hint": "Аналитика репозитория; включайте только при наличии лицензии и индекса."},
        "dbhub":     {"label": "DBHub",           "hint": "Шлюз БД; нужен `dbhub.toml` и DSN в проекте."},
        "headroom":  {"label": "Headroom",        "hint": "Локальный MCP-сжатие; первый запуск скачает рантайм и модель."},
        "idea":      {"label": "JetBrains IDEA",  "hint": "MCP-интеграция JetBrains IDE; сначала включите сервер в IDE."},
    },
    "ar": {
        "serena":    {"label": "Serena",          "hint": "ملاحة وتحرير دلالي للكود عبر خادم MCP."},
        "codegraph": {"label": "CodeGraph",       "hint": "تحليل علاقات المستودع؛ نفّذ `codegraph init` مرة واحدة لكل مشروع."},
        "gitnexus":  {"label": "GitNexus",        "hint": "تكامل ذكاء المستودع؛ فعّله فقط عند الترخيص والفهرسة."},
        "dbhub":     {"label": "DBHub",           "hint": "بوابة قاعدة البيانات؛ يحتاج `dbhub.toml` و DSN في المشروع."},
        "headroom":  {"label": "Headroom",        "hint": "MCP ضغط محلي؛ أول تشغيل يحمّل وقت تشغيل ونموذج."},
        "idea":      {"label": "JetBrains IDEA",  "hint": "تكامل MCP لـ JetBrains IDE؛ فعّل الخادم في IDE أولاً."},
    },
    "pt": {
        "serena":    {"label": "Serena",          "hint": "Navegação e edição semântica de código via servidor MCP."},
        "codegraph": {"label": "CodeGraph",       "hint": "Análise de relacionamentos do repo; rode `codegraph init` uma vez por projeto."},
        "gitnexus":  {"label": "GitNexus",        "hint": "Inteligência do repo; habilite somente quando licenciado e indexado."},
        "dbhub":     {"label": "DBHub",           "hint": "Gateway de banco de dados; requer `dbhub.toml` e DSN no projeto."},
        "headroom":  {"label": "Headroom",        "hint": "MCP de compressão local; a primeira execução baixa runtime e modelo."},
        "idea":      {"label": "JetBrains IDEA",  "hint": "Integração MCP do JetBrains IDE; habilite o servidor na IDE primeiro."},
    },
    "ja": {
        "serena":    {"label": "Serena",          "hint": "MCP サーバーによるコードの意味的ナビゲーションと編集。"},
        "codegraph": {"label": "CodeGraph",       "hint": "リポジトリ関係分析; プロジェクトごとに一度 `codegraph init` を実行。"},
        "gitnexus":  {"label": "GitNexus",        "hint": "リポジトリ知能統合; ライセンスとインデックスが揃ってから有効化。"},
        "dbhub":     {"label": "DBHub",           "hint": "データベースゲートウェイ; プロジェクトに `dbhub.toml` と DSN が必要。"},
        "headroom":  {"label": "Headroom",        "hint": "ローカル圧縮 MCP; 初回実行時にランタイムとモデルをダウンロード。"},
        "idea":      {"label": "JetBrains IDEA",  "hint": "JetBrains IDE の MCP 統合; まず IDE 側でサーバーを有効化。"},
    },
}

PLUGINS = {
    "es": {
        "opencode-qoder-bridge":  {"label": "Qoder Bridge",   "hint": "Integración con Qoder; requiere una versión compatible de Node.js y `qoder login`."},
        "opencode-mem@2.24.3":     {"label": "OpenCode Memory", "hint": "Captura memoria persistente; puede generar coste de LLM tras sesiones inactivas."},
    },
    "fr": {
        "opencode-qoder-bridge":  {"label": "Qoder Bridge",   "hint": "Intégration Qoder ; nécessite une version Node.js compatible et `qoder login`."},
        "opencode-mem@2.24.3":     {"label": "OpenCode Memory", "hint": "Capture de mémoire persistante ; peut entraîner un coût LLM après des sessions inactives."},
    },
    "ru": {
        "opencode-qoder-bridge":  {"label": "Qoder Bridge",   "hint": "Интеграция с Qoder; требуется поддерживаемая версия Node.js и `qoder login`."},
        "opencode-mem@2.24.3":     {"label": "OpenCode Memory", "hint": "Захват персистентной памяти; может повлечь расходы LLM после простоя."},
    },
    "ar": {
        "opencode-qoder-bridge":  {"label": "Qoder Bridge",   "hint": "تكامل Qoder؛ يحتاج إصداراً مدعوماً من Node.js و `qoder login`."},
        "opencode-mem@2.24.3":     {"label": "OpenCode Memory", "hint": "يلتقط الذاكرة الدائمة؛ قد يتحمل تكلفة LLM بعد جلسات خاملة."},
    },
    "pt": {
        "opencode-qoder-bridge":  {"label": "Qoder Bridge",   "hint": "Integração com Qoder; requer versão de Node.js compatível e `qoder login`."},
        "opencode-mem@2.24.3":     {"label": "OpenCode Memory", "hint": "Captura memória persistente; pode incorrer em custo de LLM após sessões ociosas."},
    },
    "ja": {
        "opencode-qoder-bridge":  {"label": "Qoder Bridge",   "hint": "Qoder 連携; サポートされる Node.js バージョンと `qoder login` が必要。"},
        "opencode-mem@2.24.3":     {"label": "OpenCode Memory", "hint": "永続メモリをキャプチャ; アイドル後に LLM コストが発生する場合あり。"},
    },
}

META = {
    "es": {"code": "es", "name": "Español",       "hint": "Interfaz en español"},
    "fr": {"code": "fr", "name": "Français",      "hint": "Interface en français"},
    "ru": {"code": "ru", "name": "Русский",       "hint": "Интерфейс на русском"},
    "ar": {"code": "ar", "name": "العربية",       "hint": "واجهة عربية"},
    "pt": {"code": "pt", "name": "Português",     "hint": "Interface em português"},
    "ja": {"code": "ja", "name": "日本語",         "hint": "日本語インターフェース"},
}

# ---------------------------------------------------------------------------
# Dashboard chrome strings — the labels the user sees immediately on the
# control panel and the wizard's main menu. Translated for the 6 locales
# so the panel reads natively without falling back to English.
# (Keys whose values en.json puts under toolLabels / mcpLabels / pluginLabels
# are translated in TOOLS / MCPS / PLUGINS above.)
# ---------------------------------------------------------------------------
STRS = {
    "es": {
        "wizardTitle":               "Asistente interactivo de OpenCode Prime",
        "dashboardTitle":            "Panel de control",
        "dashboardTabBasic":         "Básico",
        "dashboardTabTools":         "Herramientas",
        "dashboardTabMcp":           "MCP",
        "dashboardTabPlugins":       "Complementos",
        "dashboardTabReview":        "Revisar",
        "dashboardTabsLabel":        "Pestañas",
        "dashboardTabsHint":         "Pestañas · ←/→ · 1-5 salto · clic para cambiar",
        "dashboardTargetLabel":      "Directorio de instalación",
        "dashboardChangeSummaryLabel": "Resumen de cambios",
        "dashboardEnabledSummary":   "Se guardarán {count} integraciones activas.",
        "dashboardReviewHint":       "Usa los atajos de abajo para guardar o instalar.",
        "switchLanguageLabel":       "Cambiar idioma",
        "switchLanguageHint":        "Cambiar el idioma de la interfaz",
        "switchLangHint":            "Idioma cambiado a Español",
        "primaryAgentLabel":         "Agente principal",
        "primaryAgentHint":          "Agente activo por defecto al iniciar la sesión (default_agent)",
        "tuiModeLabel":              "Modo de TUI",
        "tuiModeHint":               "Cómo arranca `ocp tui`: directo (shell actual), espacio Herdr o espacio Luvus. Elegir un modo aprovisiona su integración.",
        "globalCommandsLabel":       "Comandos globales",
        "globalCommandsHint":        "Registra los atajos ocp / opencode-prime en ~/.local/bin y añádelos al PATH",
        "globalCommandsEnabled":     "ACTIVADO",
        "globalCommandsDisabled":    "DESACTIVADO",
        "saveOnlyBtn":               "💾 GUARDAR CONFIGURACIÓN",
        "saveAndInstallBtn":         "🚀 GUARDAR E INSTALAR",
        "footerHelp":                "[ ↑/↓/j/k: Mover ]  [ ←/→: Pestaña ]  [ 1-5: Saltar ]  [ Espacio/Enter: Aplicar ]  [ L: Idioma ]  [ ^S: Guardar ]  [ ^T: Instalar ]  [ Esc: Atrás ]",
        "enabled":                   "ACTIVADO",
        "disabled":                  "DESACTIVADO",
    },
    "fr": {
        "wizardTitle":               "Assistant interactif OpenCode Prime",
        "dashboardTitle":            "Centre de contrôle",
        "dashboardTabBasic":         "Base",
        "dashboardTabTools":         "Outils",
        "dashboardTabMcp":           "MCP",
        "dashboardTabPlugins":       "Extensions",
        "dashboardTabReview":        "Vérifier",
        "dashboardTabsLabel":        "Onglets",
        "dashboardTabsHint":         "Onglets · ←/→ · 1-5 saut · clic pour changer",
        "dashboardTargetLabel":      "Répertoire d'installation",
        "dashboardChangeSummaryLabel": "Résumé des modifications",
        "dashboardEnabledSummary":   "{count} intégrations actives seront enregistrées.",
        "dashboardReviewHint":       "Utilisez les raccourcis ci-dessous pour enregistrer ou installer.",
        "switchLanguageLabel":       "Changer de langue",
        "switchLanguageHint":        "Modifier la langue d'affichage",
        "switchLangHint":            "Langue changée en Français",
        "primaryAgentLabel":         "Agent principal",
        "primaryAgentHint":          "Agent actif par défaut au démarrage de la session (default_agent)",
        "tuiModeLabel":              "Mode TUI",
        "tuiModeHint":               "Comment `ocp tui` démarre : direct (shell actuel), espace Herdr ou espace Luvus. Choisir un mode provisionne son intégration.",
        "globalCommandsLabel":       "Commandes globales",
        "globalCommandsHint":        "Enregistre les raccourcis ocp / opencode-prime dans ~/.local/bin et les ajoute au PATH",
        "globalCommandsEnabled":     "ACTIVÉ",
        "globalCommandsDisabled":    "DÉSACTIVÉ",
        "saveOnlyBtn":               "💾 ENREGISTRER LA CONFIGURATION",
        "saveAndInstallBtn":         "🚀 ENREGISTRER ET INSTALLER",
        "footerHelp":                "[ ↑/↓/j/k: Déplacer ]  [ ←/→: Onglet ]  [ 1-5: Sauter ]  [ Espace/Entrée: Appliquer ]  [ L: Langue ]  [ ^S: Enregistrer ]  [ ^T: Installer ]  [ Esc: Retour ]",
        "enabled":                   "ACTIVÉ",
        "disabled":                  "DÉSACTIVÉ",
    },
    "ru": {
        "wizardTitle":               "Интерактивный помощник OpenCode Prime",
        "dashboardTitle":            "Панель управления",
        "dashboardTabBasic":         "Основное",
        "dashboardTabTools":         "Инструменты",
        "dashboardTabMcp":           "MCP",
        "dashboardTabPlugins":       "Плагины",
        "dashboardTabReview":        "Проверка",
        "dashboardTabsLabel":        "Вкладки",
        "dashboardTabsHint":         "Вкладки · ←/→ · 1-5 переход · клик для переключения",
        "dashboardTargetLabel":      "Каталог установки",
        "dashboardChangeSummaryLabel": "Сводка изменений",
        "dashboardEnabledSummary":   "Будет сохранено {count} включённых интеграций.",
        "dashboardReviewHint":       "Используйте сочетания ниже, чтобы сохранить или установить.",
        "switchLanguageLabel":       "Сменить язык",
        "switchLanguageHint":        "Изменить язык интерфейса",
        "switchLangHint":            "Язык переключён на Русский",
        "primaryAgentLabel":         "Основной агент",
        "primaryAgentHint":          "Агент по умолчанию при запуске сессии (default_agent)",
        "tuiModeLabel":              "Режим TUI",
        "tuiModeHint":               "Как запускается `ocp tui`: напрямую (текущая оболочка), рабочее пространство Herdr или Luvus. Выбор режима подключает соответствующую интеграцию.",
        "globalCommandsLabel":       "Глобальные команды",
        "globalCommandsHint":        "Регистрирует ярлыки ocp / opencode-prime в ~/.local/bin и добавляет их в PATH",
        "globalCommandsEnabled":     "ВКЛЮЧЕНО",
        "globalCommandsDisabled":    "ОТКЛЮЧЕНО",
        "saveOnlyBtn":               "💾 СОХРАНИТЬ КОНФИГУРАЦИЮ",
        "saveAndInstallBtn":         "🚀 СОХРАНИТЬ И УСТАНОВИТЬ",
        "footerHelp":                "[ ↑/↓/j/k: Двигать ]  [ ←/→: Вкладка ]  [ 1-5: Перейти ]  [ Пробел/Enter: Применить ]  [ L: Язык ]  [ ^S: Сохранить ]  [ ^T: Установить ]  [ Esc: Назад ]",
        "enabled":                   "ВКЛЮЧЕНО",
        "disabled":                  "ОТКЛЮЧЕНО",
    },
    "ar": {
        "wizardTitle":               "معالج OpenCode Prime التفاعلي",
        "dashboardTitle":            "لوحة التحكم",
        "dashboardTabBasic":         "أساسي",
        "dashboardTabTools":         "أدوات",
        "dashboardTabMcp":           "MCP",
        "dashboardTabPlugins":       "إضافات",
        "dashboardTabReview":        "مراجعة",
        "dashboardTabsLabel":        "التبويبات",
        "dashboardTabsHint":         "التبويبات · ←/→ · 1-5 قفز · انقر للتبديل",
        "dashboardTargetLabel":      "دليل التثبيت",
        "dashboardChangeSummaryLabel": "ملخص التغييرات",
        "dashboardEnabledSummary":   "سيتم حفظ {count} تكاملاً مفعّلاً.",
        "dashboardReviewHint":       "استخدم الاختصارات أدناه للحفظ أو التثبيت.",
        "switchLanguageLabel":       "تغيير اللغة",
        "switchLanguageHint":        "تغيير لغة العرض",
        "switchLangHint":            "تم تغيير اللغة إلى العربية",
        "primaryAgentLabel":         "الوكيل الأساسي",
        "primaryAgentHint":          "الوكيل النشط افتراضياً عند بدء الجلسة (default_agent)",
        "tuiModeLabel":              "وضع TUI",
        "tuiModeHint":               "كيف يبدأ `ocp tui`: مباشر (الشل الحالية)، مساحة عمل Herdr أو Luvus. اختيار الوضع يُعدّ تكامله.",
        "globalCommandsLabel":       "الأوامر العامة",
        "globalCommandsHint":        "يسجّل اختصارات ocp / opencode-prime في ~/.local/bin ويضيفها إلى PATH",
        "globalCommandsEnabled":     "مُفعّل",
        "globalCommandsDisabled":    "مُعطّل",
        "saveOnlyBtn":               "💾 حفظ الإعدادات",
        "saveAndInstallBtn":         "🚀 حفظ وتثبيت",
        "footerHelp":                "[ ↑/↓/j/k: تحرّك ]  [ ←/→: تبويب ]  [ 1-5: قفز ]  [ مسافة/إدخال: تطبيق ]  [ L: لغة ]  [ ^S: حفظ ]  [ ^T: تثبيت ]  [ Esc: رجوع ]",
        "enabled":                   "مُفعّل",
        "disabled":                  "مُعطّل",
    },
    "pt": {
        "wizardTitle":               "Assistente interativo do OpenCode Prime",
        "dashboardTitle":            "Painel de controle",
        "dashboardTabBasic":         "Básico",
        "dashboardTabTools":         "Ferramentas",
        "dashboardTabMcp":           "MCP",
        "dashboardTabPlugins":       "Plugins",
        "dashboardTabReview":        "Revisar",
        "dashboardTabsLabel":        "Abas",
        "dashboardTabsHint":         "Abas · ←/→ · 1-5 pular · clique para alternar",
        "dashboardTargetLabel":      "Diretório de instalação",
        "dashboardChangeSummaryLabel": "Resumo das alterações",
        "dashboardEnabledSummary":   "{count} integrações ativas serão salvas.",
        "dashboardReviewHint":       "Use os atalhos abaixo para salvar ou instalar.",
        "switchLanguageLabel":       "Trocar idioma",
        "switchLanguageHint":        "Alterar o idioma de exibição",
        "switchLangHint":            "Idioma alterado para Português",
        "primaryAgentLabel":         "Agente principal",
        "primaryAgentHint":          "Agente ativo por padrão ao iniciar a sessão (default_agent)",
        "tuiModeLabel":              "Modo TUI",
        "tuiModeHint":               "Como `ocp tui` inicia: direto (shell atual), workspace Herdr ou Luvus. Escolher um modo provisiona sua integração.",
        "globalCommandsLabel":       "Comandos globais",
        "globalCommandsHint":        "Registra os atalhos ocp / opencode-prime em ~/.local/bin e os adiciona ao PATH",
        "globalCommandsEnabled":     "ATIVADO",
        "globalCommandsDisabled":    "DESATIVADO",
        "saveOnlyBtn":               "💾 SALVAR CONFIGURAÇÃO",
        "saveAndInstallBtn":         "🚀 SALVAR E INSTALAR",
        "footerHelp":                "[ ↑/↓/j/k: Mover ]  [ ←/→: Aba ]  [ 1-5: Pular ]  [ Espaço/Enter: Aplicar ]  [ L: Idioma ]  [ ^S: Salvar ]  [ ^T: Instalar ]  [ Esc: Voltar ]",
        "enabled":                   "ATIVADO",
        "disabled":                  "DESATIVADO",
    },
    "ja": {
        "wizardTitle":               "OpenCode Prime インタラクティブ・ウィザード",
        "dashboardTitle":            "ダッシュボード",
        "dashboardTabBasic":         "基本",
        "dashboardTabTools":         "ツール",
        "dashboardTabMcp":           "MCP",
        "dashboardTabPlugins":       "プラグイン",
        "dashboardTabReview":        "確認",
        "dashboardTabsLabel":        "タブ",
        "dashboardTabsHint":         "タブ · ←/→ · 1-5 ジャンプ · クリックで切替",
        "dashboardTargetLabel":      "インストール先",
        "dashboardChangeSummaryLabel": "変更の概要",
        "dashboardEnabledSummary":   "{count} 件の有効な統合が保存されます。",
        "dashboardReviewHint":       "下のショートカットで保存またはインストール。",
        "switchLanguageLabel":       "言語を切り替える",
        "switchLanguageHint":        "表示言語の変更",
        "switchLangHint":            "言語を日本語に切り替えました",
        "primaryAgentLabel":         "メインエージェント",
        "primaryAgentHint":          "セッション開始時の既定エージェント (default_agent)",
        "tuiModeLabel":              "TUI モード",
        "tuiModeHint":               "`ocp tui` の起動方法: 直接 (現在のシェル)、Herdr ワークスペース、Luvus ワークスペース。モード選択で対応する統合がプロビジョニングされます。",
        "globalCommandsLabel":       "グローバルコマンド",
        "globalCommandsHint":        "ocp / opencode-prime のショートカットを ~/.local/bin に登録して PATH に追加",
        "globalCommandsEnabled":     "有効",
        "globalCommandsDisabled":    "無効",
        "saveOnlyBtn":               "💾 設定を保存",
        "saveAndInstallBtn":         "🚀 保存してインストール",
        "footerHelp":                "[ ↑/↓/j/k: 移動 ]  [ ←/→: タブ ]  [ 1-5: ジャンプ ]  [ スペース/Enter: 適用 ]  [ L: 言語 ]  [ ^S: 保存 ]  [ ^T: インストール ]  [ Esc: 戻る ]",
        "enabled":                   "有効",
        "disabled":                  "無効",
    },
}

# ---------------------------------------------------------------------------
# Generator. Each new locale file is `FALLBACK_EN + _meta override +
# chrome override + tool/mcp/plugin override`. Missing keys still fall
# through to English.
# ---------------------------------------------------------------------------
with open(EN, "r", encoding="utf-8") as f:
    en_data = json.load(f)

for code in ["es", "fr", "ru", "ar", "pt", "ja"]:
    out = dict(en_data)  # shallow clone — every key from en
    out["_meta"] = META[code]
    out.update(STRS[code])
    out["toolLabels"] = TOOLS[code]
    out["mcpLabels"] = MCPS[code]
    out["pluginLabels"] = PLUGINS[code]

    out_path = OUT / f"{code}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"Wrote {out_path} — {len(out)} keys (en fallback + chrome + 15 tool/mcp/plugin overrides)")