/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import { getCaseInsensitive } from 'vs/base/common/objects';
import * as path from 'vs/base/common/path';
import { IProcessEnvironment, isWindows, locale, OperatingSystem, OS } from 'vs/base/common/platform';
import * as process from 'vs/base/common/process';
import { sanitizeProcessEnvironment } from 'vs/base/common/processes';
import { isString } from 'vs/base/common/types';
import * as pfs from 'vs/base/node/pfs';
import { ILogService } from 'vs/platform/log/common/log';
import { IShellLaunchConfig, ITerminalEnvironment, TerminalSettingId } from 'vs/platform/terminal/common/terminal';
import { Uri } from 'vscode';

export function getWindowsBuildNumber(): number {
	const osVersion = (/(\d+)\.(\d+)\.(\d+)/g).exec(os.release());
	let buildNumber: number = 0;
	if (osVersion && osVersion.length === 4) {
		buildNumber = parseInt(osVersion[3]);
	}
	return buildNumber;
}

export async function findExecutable(command: string, cwd?: string, paths?: string[], env: IProcessEnvironment = process.env as IProcessEnvironment, exists: (path: string) => Promise<boolean> = pfs.Promises.exists): Promise<string | undefined> {
	// If we have an absolute path then we take it.
	if (path.isAbsolute(command)) {
		return await exists(command) ? command : undefined;
	}
	if (cwd === undefined) {
		cwd = process.cwd();
	}
	const dir = path.dirname(command);
	if (dir !== '.') {
		// We have a directory and the directory is relative (see above). Make the path absolute
		// to the current working directory.
		const fullPath = path.join(cwd, command);
		return await exists(fullPath) ? fullPath : undefined;
	}
	const envPath = getCaseInsensitive(env, 'PATH');
	if (paths === undefined && isString(envPath)) {
		paths = envPath.split(path.delimiter);
	}
	// No PATH environment. Make path absolute to the cwd.
	if (paths === undefined || paths.length === 0) {
		const fullPath = path.join(cwd, command);
		return await exists(fullPath) ? fullPath : undefined;
	}
	// We have a simple file name. We get the path variable from the env
	// and try to find the executable on the path.
	for (let pathEntry of paths) {
		// The path entry is absolute.
		let fullPath: string;
		if (path.isAbsolute(pathEntry)) {
			fullPath = path.join(pathEntry, command);
		} else {
			fullPath = path.join(cwd, pathEntry, command);
		}

		if (await exists(fullPath)) {
			return fullPath;
		}
		if (isWindows) {
			let withExtension = fullPath + '.com';
			if (await exists(withExtension)) {
				return withExtension;
			}
			withExtension = fullPath + '.exe';
			if (await exists(withExtension)) {
				return withExtension;
			}
		}
	}
	const fullPath = path.join(cwd, command);
	return await exists(fullPath) ? fullPath : undefined;
}


export function createTerminalEnvironment(
	shellLaunchConfig: IShellLaunchConfig,
	envFromConfig: ITerminalEnvironment | undefined,
	variableResolver: VariableResolver | undefined,
	version: string | undefined,
	detectLocale: 'auto' | 'off' | 'on',
	baseEnv: IProcessEnvironment
): IProcessEnvironment {
	// Create a terminal environment based on settings, launch config and permissions
	const env: IProcessEnvironment = {};
	if (shellLaunchConfig.strictEnv) {
		// strictEnv is true, only use the requested env (ignoring null entries)
		mergeNonNullKeys(env, shellLaunchConfig.env);
	} else {
		// Merge process env with the env from config and from shellLaunchConfig
		mergeNonNullKeys(env, baseEnv);

		const allowedEnvFromConfig = { ...envFromConfig };

		// Resolve env vars from config and shell
		if (variableResolver) {
			if (allowedEnvFromConfig) {
				resolveConfigurationVariables(variableResolver, allowedEnvFromConfig);
			}
			if (shellLaunchConfig.env) {
				resolveConfigurationVariables(variableResolver, shellLaunchConfig.env);
			}
		}

		// Sanitize the environment, removing any undesirable VS Code and Electron environment
		// variables
		sanitizeProcessEnvironment(env, 'VSCODE_IPC_HOOK_CLI');

		// Merge config (settings) and ShellLaunchConfig environments
		mergeEnvironments(env, allowedEnvFromConfig);
		mergeEnvironments(env, shellLaunchConfig.env);

		// Adding other env keys necessary to create the process
		addTerminalEnvironmentKeys(env, version, locale, detectLocale);
	}
	return env;
}

/**
 * This module contains utility functions related to the environment, cwd and paths.
 */

export function mergeEnvironments(parent: IProcessEnvironment, other: ITerminalEnvironment | undefined): void {
	if (!other) {
		return;
	}

	// On Windows apply the new values ignoring case, while still retaining
	// the case of the original key.
	if (isWindows) {
		for (const configKey in other) {
			let actualKey = configKey;
			for (const envKey in parent) {
				if (configKey.toLowerCase() === envKey.toLowerCase()) {
					actualKey = envKey;
					break;
				}
			}
			const value = other[configKey];
			if (value !== undefined) {
				_mergeEnvironmentValue(parent, actualKey, value);
			}
		}
	} else {
		Object.keys(other).forEach((key) => {
			const value = other[key];
			if (value !== undefined) {
				_mergeEnvironmentValue(parent, key, value);
			}
		});
	}
}

function _mergeEnvironmentValue(env: ITerminalEnvironment, key: string, value: string | null): void {
	if (typeof value === 'string') {
		env[key] = value;
	} else {
		delete env[key];
	}
}

export function addTerminalEnvironmentKeys(env: IProcessEnvironment, version: string | undefined, locale: string | undefined, detectLocale: 'auto' | 'off' | 'on'): void {
	env['TERM_PROGRAM'] = 'vscode';
	if (version) {
		env['TERM_PROGRAM_VERSION'] = version;
	}
	if (shouldSetLangEnvVariable(env, detectLocale)) {
		env['LANG'] = getLangEnvVariable(locale);
	}
	env['COLORTERM'] = 'truecolor';
}

function mergeNonNullKeys(env: IProcessEnvironment, other: ITerminalEnvironment | undefined) {
	if (!other) {
		return;
	}
	for (const key of Object.keys(other)) {
		const value = other[key];
		if (value) {
			env[key] = value;
		}
	}
}

function resolveConfigurationVariables(variableResolver: VariableResolver, env: ITerminalEnvironment): ITerminalEnvironment {
	Object.keys(env).forEach((key) => {
		const value = env[key];
		if (typeof value === 'string') {
			try {
				env[key] = variableResolver(value);
			} catch (e) {
				env[key] = value;
			}
		}
	});
	return env;
}

export function shouldSetLangEnvVariable(env: IProcessEnvironment, detectLocale: 'auto' | 'off' | 'on'): boolean {
	if (detectLocale === 'on') {
		return true;
	}
	if (detectLocale === 'auto') {
		const lang = env['LANG'];
		return !lang || (lang.search(/\.UTF\-8$/) === -1 && lang.search(/\.utf8$/) === -1 && lang.search(/\.euc.+/) === -1);
	}
	return false; // 'off'
}

export function getLangEnvVariable(locale?: string): string {
	const parts = locale ? locale.split('-') : [];
	const n = parts.length;
	if (n === 0) {
		// Fallback to en_US if the locale is unknown
		return 'en_US.UTF-8';
	}
	if (n === 1) {
		// The local may only contain the language, not the variant, if this is the case guess the
		// variant such that it can be used as a valid $LANG variable. The language variant chosen
		// is the original and/or most prominent with help from
		// https://stackoverflow.com/a/2502675/1156119
		// The list of locales was generated by running `locale -a` on macOS
		const languageVariants: { [key: string]: string } = {
			af: 'ZA',
			am: 'ET',
			be: 'BY',
			bg: 'BG',
			ca: 'ES',
			cs: 'CZ',
			da: 'DK',
			// de: 'AT',
			// de: 'CH',
			de: 'DE',
			el: 'GR',
			// en: 'AU',
			// en: 'CA',
			// en: 'GB',
			// en: 'IE',
			// en: 'NZ',
			en: 'US',
			es: 'ES',
			et: 'EE',
			eu: 'ES',
			fi: 'FI',
			// fr: 'BE',
			// fr: 'CA',
			// fr: 'CH',
			fr: 'FR',
			he: 'IL',
			hr: 'HR',
			hu: 'HU',
			hy: 'AM',
			is: 'IS',
			// it: 'CH',
			it: 'IT',
			ja: 'JP',
			kk: 'KZ',
			ko: 'KR',
			lt: 'LT',
			// nl: 'BE',
			nl: 'NL',
			no: 'NO',
			pl: 'PL',
			pt: 'BR',
			// pt: 'PT',
			ro: 'RO',
			ru: 'RU',
			sk: 'SK',
			sl: 'SI',
			sr: 'YU',
			sv: 'SE',
			tr: 'TR',
			uk: 'UA',
			zh: 'CN',
		};
		if (parts[0] in languageVariants) {
			parts.push(languageVariants[parts[0]]);
		}
	} else {
		// Ensure the variant is uppercase to be a valid $LANG
		parts[1] = parts[1].toUpperCase();
	}
	return parts.join('_') + '.UTF-8';
}

export function getCwd(
	shell: IShellLaunchConfig,
	userHome: string | undefined,
	variableResolver: VariableResolver | undefined,
	root: Uri | undefined,
	customCwd: string | undefined,
	logService?: ILogService
): string {
	if (shell.cwd) {
		const unresolved = (typeof shell.cwd === 'object') ? shell.cwd.fsPath : shell.cwd;
		const resolved = _resolveCwd(unresolved, variableResolver);
		return _sanitizeCwd(resolved || unresolved);
	}

	let cwd: string | undefined;

	if (!shell.ignoreConfigurationCwd && customCwd) {
		if (variableResolver) {
			customCwd = _resolveCwd(customCwd, variableResolver, logService);
		}
		if (customCwd) {
			if (path.isAbsolute(customCwd)) {
				cwd = customCwd;
			} else if (root) {
				cwd = path.join(root.fsPath, customCwd);
			}
		}
	}

	// If there was no custom cwd or it was relative with no workspace
	if (!cwd) {
		cwd = root ? root.fsPath : userHome || '';
	}

	return _sanitizeCwd(cwd);
}

function _resolveCwd(cwd: string, variableResolver: VariableResolver | undefined, logService?: ILogService): string | undefined {
	if (variableResolver) {
		try {
			return variableResolver(cwd);
		} catch (e) {
			logService?.error('Could not resolve terminal cwd', e);
			return undefined;
		}
	}
	return cwd;
}

function _sanitizeCwd(cwd: string): string {
	// Make the drive letter uppercase on Windows (see #9448)
	if (OS === OperatingSystem.Windows && cwd && cwd[1] === ':') {
		return cwd[0].toUpperCase() + cwd.substr(1);
	}
	return cwd;
}

export type TerminalShellSetting = (
	TerminalSettingId.AutomationShellWindows
	| TerminalSettingId.AutomationShellMacOs
	| TerminalSettingId.AutomationShellLinux
	| TerminalSettingId.ShellWindows
	| TerminalSettingId.ShellMacOs
	| TerminalSettingId.ShellLinux
);

export type TerminalShellArgsSetting = (
	TerminalSettingId.ShellArgsWindows
	| TerminalSettingId.ShellArgsMacOs
	| TerminalSettingId.ShellArgsLinux
);

export type VariableResolver = (str: string) => string;
/**
 * @deprecated Use ITerminalProfileResolverService
 */
