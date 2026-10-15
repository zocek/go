// Generates the native notification texts from locales/<code>/notifications.json
// so that adding a language never touches native code (docs/i18n, section 4.6):
//
// - Android: res/values/strings_notifications.xml (English, the default) and
//   res/values-b+<code>/strings_notifications.xml for every other language with
//   <string> resources and a <plurals name="notification_sats"> resource.
//   The file name differs from strings.xml so it never collides with the
//   strings.xml files Expo writes for the `locales` config.
// - iOS: NotificationServiceExtension/<code>.lproj/Localizable.strings and
//   Localizable.stringsdict (NSStringPluralRuleType), registered in the Xcode
//   project as localized variant groups of the NotificationServiceExtension
//   target created by expo-notification-service-extension-plugin.
//
// Registration order: Expo runs the mods of the plugin listed LATER in
// `plugins` FIRST, so this plugin must be listed BEFORE
// "expo-notification-service-extension-plugin" in app.config.js, otherwise the
// NotificationServiceExtension target does not exist yet when the Xcode project
// is modified (the plugin then only warns and skips the iOS project changes).
const {
  WarningAggregator,
  withDangerousMod,
  withXcodeProject,
} = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const PLUGIN_NAME = "withNotificationLocales";
const DEFAULT_LANGUAGE = "en";
const AREA_FILE_NAME = "notifications.json";
const NSE_TARGET_NAME = "NotificationServiceExtension";
const ANDROID_FILE_NAME = "strings_notifications.xml";
const IOS_STRINGS_FILE_NAME = "Localizable.strings";
const IOS_STRINGSDICT_FILE_NAME = "Localizable.stringsdict";
// CLDR plural categories as used by i18next suffixes, Android <plurals> and iOS .stringsdict
const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];
// translation key -> native resource name
const STRING_RESOURCES = {
  sent: "notification_sent",
  received: "notification_received",
  paymentHeld: "notification_payment_held",
};
// translation key prefix (sats_one, sats_few, ...) -> native plural resource name
const PLURAL_KEY = "sats";
const PLURAL_RESOURCE = "notification_sats";

function withNotificationLocales(config) {
  config = withDangerousMod(config, [
    "android",
    async (config) => {
      const locales = readNotificationLocales(
        getLocalesDir(config.modRequest.projectRoot),
      );
      writeAndroidResources(
        path.join(
          config.modRequest.platformProjectRoot,
          "app",
          "src",
          "main",
          "res",
        ),
        locales,
      );
      return config;
    },
  ]);
  config = withDangerousMod(config, [
    "ios",
    async (config) => {
      const locales = readNotificationLocales(
        getLocalesDir(config.modRequest.projectRoot),
      );
      writeIosResources(
        path.join(config.modRequest.platformProjectRoot, NSE_TARGET_NAME),
        locales,
      );
      return config;
    },
  ]);
  config = withXcodeProject(config, (config) => {
    const locales = readNotificationLocales(
      getLocalesDir(config.modRequest.projectRoot),
    );
    addLocalesToXcodeProject(config.modResults, locales);
    return config;
  });
  return config;
}

function getLocalesDir(projectRoot) {
  return path.join(projectRoot, "locales");
}

// Reads every locales/<code>/notifications.json; directories without the file
// (e.g. locales/native) are skipped. English is required and comes first.
function readNotificationLocales(localesDir) {
  const locales = [];
  for (const code of fs.readdirSync(localesDir).sort()) {
    const filePath = path.join(localesDir, code, AREA_FILE_NAME);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const source = `locales/${code}/${AREA_FILE_NAME}`;
    let json;
    try {
      json = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new Error(`${PLUGIN_NAME}: ${source}: ${error.message}`);
    }
    locales.push(parseNotificationLocale(code, json, source));
  }
  if (!locales.some((locale) => locale.code === DEFAULT_LANGUAGE)) {
    throw new Error(
      `${PLUGIN_NAME}: locales/${DEFAULT_LANGUAGE}/${AREA_FILE_NAME} is required`,
    );
  }
  locales.sort((a, b) => {
    if (a.code === DEFAULT_LANGUAGE) {
      return -1;
    }
    if (b.code === DEFAULT_LANGUAGE) {
      return 1;
    }
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
  return locales;
}

function parseNotificationLocale(code, json, source) {
  const strings = {};
  const plurals = {};
  for (const [key, value] of Object.entries(json)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `${PLUGIN_NAME}: ${source}: "${key}" must be a non-empty string`,
      );
    }
    if (STRING_RESOURCES[key]) {
      strings[STRING_RESOURCES[key]] = value;
      continue;
    }
    const separator = key.lastIndexOf("_");
    const category = key.slice(separator + 1);
    if (
      separator > 0 &&
      key.slice(0, separator) === PLURAL_KEY &&
      PLURAL_CATEGORIES.includes(category)
    ) {
      plurals[category] = value;
      continue;
    }
    throw new Error(`${PLUGIN_NAME}: ${source}: unknown key "${key}"`);
  }
  for (const [key, resource] of Object.entries(STRING_RESOURCES)) {
    if (!strings[resource]) {
      throw new Error(`${PLUGIN_NAME}: ${source}: missing key "${key}"`);
    }
  }
  if (!plurals.other) {
    throw new Error(
      `${PLUGIN_NAME}: ${source}: missing key "${PLURAL_KEY}_other"`,
    );
  }
  return { code, strings, plurals };
}

function getPluralCategories(locale) {
  return PLURAL_CATEGORIES.filter((category) => locale.plurals[category]);
}

function getGeneratedComment(locale) {
  return `Generated by plugins/${PLUGIN_NAME}.js from locales/${locale.code}/${AREA_FILE_NAME}. Do not edit.`;
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Android string resources: backslash escapes for quotes, apostrophes and line
// breaks, a leading @ or ? would otherwise be read as a resource reference.
function escapeAndroidString(value) {
  let escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  if (escaped.startsWith("@") || escaped.startsWith("?")) {
    escaped = `\\${escaped}`;
  }
  return escapeXml(escaped);
}

function escapeIosString(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function getAndroidValuesDirName(code) {
  return code === DEFAULT_LANGUAGE
    ? "values"
    : `values-b+${code.replace(/-/g, "+")}`;
}

function buildAndroidStringsXml(locale) {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<!-- ${getGeneratedComment(locale)} -->`,
    "<resources>",
  ];
  for (const [name, value] of Object.entries(locale.strings)) {
    lines.push(
      `  <string name="${name}">${escapeAndroidString(value)}</string>`,
    );
  }
  lines.push(`  <plurals name="${PLURAL_RESOURCE}">`);
  for (const category of getPluralCategories(locale)) {
    lines.push(
      `    <item quantity="${category}">${escapeAndroidString(locale.plurals[category])}</item>`,
    );
  }
  lines.push("  </plurals>", "</resources>", "");
  return lines.join("\n");
}

function buildIosStrings(locale) {
  const lines = [`/* ${getGeneratedComment(locale)} */`];
  for (const [name, value] of Object.entries(locale.strings)) {
    lines.push(`"${name}" = "${escapeIosString(value)}";`);
  }
  lines.push("");
  return lines.join("\n");
}

// The plural variants contain only the unit word; the %ld argument selects the
// category and is not printed. Usage in NotificationService.m:
// [[NSString alloc] initWithFormat:<notification_sats> locale:<locale>, (long)amount]
function buildIosStringsDict(locale) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- ${getGeneratedComment(locale)} -->`,
    '<plist version="1.0">',
    "<dict>",
    `\t<key>${PLURAL_RESOURCE}</key>`,
    "\t<dict>",
    "\t\t<key>NSStringLocalizedFormatKey</key>",
    `\t\t<string>%#@${PLURAL_KEY}@</string>`,
    `\t\t<key>${PLURAL_KEY}</key>`,
    "\t\t<dict>",
    "\t\t\t<key>NSStringFormatSpecTypeKey</key>",
    "\t\t\t<string>NSStringPluralRuleType</string>",
    "\t\t\t<key>NSStringFormatValueTypeKey</key>",
    "\t\t\t<string>ld</string>",
  ];
  for (const category of getPluralCategories(locale)) {
    lines.push(
      `\t\t\t<key>${category}</key>`,
      `\t\t\t<string>${escapeXml(locale.plurals[category])}</string>`,
    );
  }
  lines.push("\t\t</dict>", "\t</dict>", "</dict>", "</plist>", "");
  return lines.join("\n");
}

function writeAndroidResources(resDir, locales) {
  const written = [];
  for (const locale of locales) {
    const dir = path.join(resDir, getAndroidValuesDirName(locale.code));
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, ANDROID_FILE_NAME);
    fs.writeFileSync(filePath, buildAndroidStringsXml(locale));
    written.push(filePath);
  }
  return written;
}

function writeIosResources(nseDir, locales) {
  const written = [];
  for (const locale of locales) {
    const dir = path.join(nseDir, `${locale.code}.lproj`);
    fs.mkdirSync(dir, { recursive: true });
    const stringsPath = path.join(dir, IOS_STRINGS_FILE_NAME);
    fs.writeFileSync(stringsPath, buildIosStrings(locale));
    const stringsDictPath = path.join(dir, IOS_STRINGSDICT_FILE_NAME);
    fs.writeFileSync(stringsDictPath, buildIosStringsDict(locale));
    written.push(stringsPath, stringsDictPath);
  }
  return written;
}

// Registers <code>.lproj/Localizable.strings and Localizable.stringsdict as
// localized variant groups in the NotificationServiceExtension group and adds
// them to the Resources build phase of the NotificationServiceExtension target.
// Idempotent: existing variant groups, build files, file references and known
// regions are reused. Returns false when the target is missing.
function addLocalesToXcodeProject(project, locales) {
  const targetUuid = findNativeTargetUuid(project, NSE_TARGET_NAME);
  if (!targetUuid) {
    WarningAggregator.addWarningIOS(
      PLUGIN_NAME,
      `Xcode target "${NSE_TARGET_NAME}" not found, notification translations were not added. List ${PLUGIN_NAME} before "expo-notification-service-extension-plugin" in app.config.js.`,
    );
    return false;
  }
  const groupKey = findGroupKeyByPath(project, NSE_TARGET_NAME);
  if (!groupKey) {
    WarningAggregator.addWarningIOS(
      PLUGIN_NAME,
      `Xcode group "${NSE_TARGET_NAME}" not found, notification translations were not added.`,
    );
    return false;
  }
  if (!project.pbxResourcesBuildPhaseObj(targetUuid)) {
    project.addBuildPhase(
      [],
      "PBXResourcesBuildPhase",
      "Resources",
      targetUuid,
    );
  }
  const codes = locales.map((locale) => locale.code);
  addLocalizedVariantGroup(project, {
    targetUuid,
    groupKey,
    fileName: IOS_STRINGS_FILE_NAME,
    fileType: "text.plist.strings",
    codes,
  });
  addLocalizedVariantGroup(project, {
    targetUuid,
    groupKey,
    fileName: IOS_STRINGSDICT_FILE_NAME,
    fileType: "text.plist.stringsdict",
    codes,
  });
  if (typeof project.addKnownRegion === "function") {
    for (const code of codes) {
      project.addKnownRegion(toPbxString(code));
    }
  }
  return true;
}

function addLocalizedVariantGroup(
  project,
  { targetUuid, groupKey, fileName, fileType, codes },
) {
  const objects = project.hash.project.objects;
  const group = objects.PBXGroup[groupKey];
  const existingChild = group.children.find(
    (child) =>
      child.comment === fileName && getVariantGroup(project, child.value),
  );
  let variantGroupKey = existingChild ? existingChild.value : null;
  if (!variantGroupKey) {
    variantGroupKey = project.pbxCreateVariantGroup(fileName);
    group.children.push({ value: variantGroupKey, comment: fileName });
  }
  if (!hasResourceBuildFile(project, targetUuid, variantGroupKey)) {
    const buildFile = {
      uuid: project.generateUuid(),
      fileRef: variantGroupKey,
      basename: fileName,
      group: "Resources",
      target: targetUuid,
    };
    project.addToPbxBuildFileSection(buildFile);
    project.addToPbxResourcesBuildPhase(buildFile);
  }
  const variantGroup = getVariantGroup(project, variantGroupKey);
  for (const code of codes) {
    if (variantGroup.children.some((child) => child.comment === code)) {
      continue;
    }
    const file = {
      fileRef: project.generateUuid(),
      basename: code,
      path: `${code}.lproj/${fileName}`,
      sourceTree: '"<group>"',
      fileEncoding: 4,
      lastKnownFileType: fileType,
    };
    project.addToPbxFileReferenceSection(file);
    // the xcode writer would print `undefined` for keys without a value
    removeUndefinedKeys(project.pbxFileReferenceSection()[file.fileRef]);
    variantGroup.children.push({ value: file.fileRef, comment: code });
  }
}

function getVariantGroup(project, key) {
  const section = project.hash.project.objects.PBXVariantGroup;
  return section ? section[key] : undefined;
}

function hasResourceBuildFile(project, targetUuid, fileRef) {
  const phase = project.pbxResourcesBuildPhaseObj(targetUuid);
  if (!phase || !Array.isArray(phase.files)) {
    return false;
  }
  const buildFiles = project.pbxBuildFileSection();
  return phase.files.some(
    (entry) =>
      buildFiles[entry.value] && buildFiles[entry.value].fileRef === fileRef,
  );
}

function nonCommentEntries(section) {
  return Object.entries(section || {}).filter(
    ([key]) => !key.endsWith("_comment"),
  );
}

function unquote(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"')
    ? text.slice(1, -1)
    : text;
}

// pbxproj strings need quotes unless they consist of safe characters only
function toPbxString(value) {
  return /^[A-Za-z0-9_]+$/.test(value) ? value : `"${value}"`;
}

function findNativeTargetUuid(project, name) {
  for (const [uuid, target] of nonCommentEntries(
    project.pbxNativeTargetSection(),
  )) {
    if (unquote(target.name) === name) {
      return uuid;
    }
  }
  return null;
}

function findGroupKeyByPath(project, groupPath) {
  for (const [key, group] of nonCommentEntries(
    project.hash.project.objects.PBXGroup,
  )) {
    if (unquote(group.path) === groupPath) {
      return key;
    }
  }
  return null;
}

function removeUndefinedKeys(object) {
  for (const key of Object.keys(object)) {
    if (object[key] === undefined) {
      delete object[key];
    }
  }
}

module.exports = withNotificationLocales;
// exported for tests and scripts
module.exports.readNotificationLocales = readNotificationLocales;
module.exports.getAndroidValuesDirName = getAndroidValuesDirName;
module.exports.buildAndroidStringsXml = buildAndroidStringsXml;
module.exports.buildIosStrings = buildIosStrings;
module.exports.buildIosStringsDict = buildIosStringsDict;
module.exports.writeAndroidResources = writeAndroidResources;
module.exports.writeIosResources = writeIosResources;
module.exports.addLocalesToXcodeProject = addLocalesToXcodeProject;
