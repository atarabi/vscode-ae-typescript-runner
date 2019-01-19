import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {promisify} from 'util';
import * as tsconfig from 'tsconfig';

const findConfig = async (fileName: string) => {
	const dirName = path.dirname(fileName);
	return await tsconfig.find(dirName);
};


const getListFiles = (cwd: string) => {
	return new Promise<string[]>((resolve, reject) => {
		child_process.exec('tsc --noEmit --listFiles', { cwd }, (error, stdout, stderr) => {
			if (error) {
				return reject(`tsc isn't found`);
			}

			const paths = stdout.split('\n').map(text => {
				text = text.trim();
				if ('/' === path.sep) {
					return text;
				}
				return text.replace(/\//g, path.sep);
			}).filter(text => {
				if (/^\s+$/.test(text)) {
					return false;
				}
				return fs.existsSync(text);
			});

			resolve(paths);
		});
	});
};


const CONFIG_CACHE = new Map<string, number>();

const CACHE = new Map<string, { configPath: string; found: boolean; }>();

const fileIsListed = async (fileName: string, configPath: string) => {
	const configStat = await promisify(fs.stat)(configPath);
	const cache = CACHE.get(fileName);
	if (cache) {
		if (cache.configPath === configPath) {
			const config_cache = CONFIG_CACHE.get(configPath);
			if (config_cache === configStat.mtimeMs) {
				return cache.found;
			}
		}
	}

	CONFIG_CACHE.set(configPath, configStat.mtimeMs);

	const rootPath = path.dirname(configPath);
	const files = await getListFiles(rootPath);
	let found = false;
	for (const file of files) {
		if (file === fileName) {
			found = true;
		} else {
			CACHE.set(file, {configPath, found: true});
		}
	}
	CACHE.set(fileName, {configPath, found});
	return found;
};


const compileWithEmittedFiles = (cwd: string) => {
	return new Promise<string[]>((resolve, reject) => {
		child_process.exec('tsc --listEmittedFiles', { cwd }, (error, stdout, stderr) => {
			if (error) {
				return reject(error);
			}

			const paths = stdout.split('\n').reduce<string[]>((filtered, text) => {
				text = text.trim();
				if (text.indexOf('TSFILE:') === 0) {
					text = text.substring('TSFILE:'.length);
					filtered.push(text.trim());
				}
				return filtered;
			}, []).map(text => {
				if ('/' === path.sep) {
					return text;
				}
				return text.replace(/\//g, path.sep);
			}).filter(text => {
				if (/^\s+$/.test(text)) {
					return false;
				}
				return fs.existsSync(text);
			});

			resolve(paths);
		});
	});
};


const getMostSimilarPath = (p: string, ps: string[]) => {
	const removeExt = (p: string) => p.substring(0, p.length - path.extname(p).length);

	const pBase = removeExt(p);
	const arr: { path: string, score: number }[] = [];
	for (const _p of ps) {
		const _pBase = removeExt(_p);
		const len = Math.min(pBase.length, _pBase.length);
		let score = 0;
		for (let i = 0; i < len; ++i) {
			if (pBase[pBase.length - 1 - i] === _pBase[_pBase.length - 1 - i]) {
				score++;
			} else {
				break;
			}
		}
		arr.push({ path: _p, score })
	}

	arr.sort((lhs, rhs) => {
		if (rhs.score < lhs.score) {
			return -1;
		} else if (rhs.score > lhs.score) {
			return 1;
		}
		return 0;
	});

	return arr[0].path;
};


const findAePathWin32 = () => {
	return new Promise<string>((resolve, reject) => {
		const ps = child_process.spawn('powershell.exe', ['-Command', `(Get-WmiObject -class Win32_Process -Filter 'Name="AfterFX.exe"').path`]);

		let output = '';

		ps.stdout.on('data', (chunk => {
			output += chunk.toString();
		}));

		ps.on('exit', () => {
			const aePaths: string[] = [];
			for (let aePath of output.split(/\r\n|\r|\n/)) {
				if (aePath) {
					aePaths.push(aePath);
				}
			}
			if (aePaths.length) {
				resolve(aePaths[0]);
			} else {
				reject('Please launch After Effects.');
			}
		});

		ps.on('error', (err) => {
			reject(err);
		});

		ps.stdin.end();
	});
};


const findAePath = async () => {
	switch (process.platform) {
		case 'win32':
			return await findAePathWin32();
	}

	throw new Error(`${process.platform} isn't supported`);
};


const runScript = (aePath: string, filePath: string) => {
	aePath = aePath.indexOf(' ') === -1 ? aePath : `"${aePath}"`;
	child_process.exec(`${aePath} -r ${filePath}`, () => { });
};


export function activate(context: vscode.ExtensionContext) {

	const disposable = vscode.commands.registerCommand('ae-typescript-runner.runAeTypeScript', async () => {
		try {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				return;
			}

			const aePath = await findAePath();

			const document = editor.document;
			const fileName = document.fileName;
			const fileExt = path.extname(fileName).toLowerCase();
			switch (fileExt) {
				case '.jsxbin':
					return runScript(aePath, fileName);
				case '.js':
				case '.jsx':
				case '.ts':
				case '.tsx':
					//pass
					break;
				default:
					return;
			}
			const configPath = await findConfig(fileName);
			if (!configPath) {
				if (/\.(jsx|js)$/i.test(fileName)) {
					return runScript(aePath, fileName);
				}
				throw new Error(`Unable to find tsconfig.json`);
			}
			const found = await fileIsListed(fileName, configPath);
			if (!found) {
				if (/\.(jsx|js)$/i.test(fileName)) {
					runScript(aePath, fileName);
				}
				return;
			}
			const rootPath = path.dirname(configPath);
			const compiledFiles = await compileWithEmittedFiles(rootPath);
			if (compiledFiles.length === 0) {
				return;
			} 
			
			const target = compiledFiles.length === 1 ? compiledFiles[0] : getMostSimilarPath(fileName, compiledFiles);
			runScript(aePath, target);

		} catch (e) {
			vscode.window.showWarningMessage(e);
		}
	});

	context.subscriptions.push(disposable);
}
