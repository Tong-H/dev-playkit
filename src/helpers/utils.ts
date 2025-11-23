import path from 'path';
import fs from 'fs';
import net from 'net';
import os from 'os';
import chalk from 'chalk';
import { Page, Locator, Cookie } from 'playwright';
import { AuthAccount, MonitorConfig, ScreenshotOptions, ScreenshotResult, Settings } from '../types/monitor';
import { spawn } from 'child_process';

const red = chalk.bold.red;

export const toolName = 'dev-playkit';

// Check if port is available
export const isPortAvailable = (port: number): Promise<boolean> => {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.listen(port, () => {
			server.once('close', () => resolve(true));
			server.close();
		});
		server.on('error', () => {
			resolve(false);
		});
	});
}

// Parse command line arguments
export const parseArgs = (): Partial<MonitorConfig> & { cacheDir: string } => {
	const args = process.argv.slice(2);
	const config: any = args.filter(i => /^--[a-zA-Z]*=?/.test(i)).reduce((acc: any, cur) => {
		const match = /^--([a-zA-Z-_]*)=?(.*)?/.exec(cur);
		if (!match) return acc;

		const [, key, value] = match;
		if (value === "true" || value === "false") {
			acc[key] = value === "true"
		} else if (['null', 'undefined'].includes(value)) {
			return acc
		} else if (key) {
			acc[key] = value === undefined ? true : value;
		}
		return acc
	}, {})

	if ("cookie" in config) {
		const authData: Cookie[] = config.cookie.split(";").reduce((acc: Cookie[], cur: string) => {
			const [name, value] = cur.split("=");
			return [...acc, {
				name,
				value,
				domain: '',
				path: '',
				expires: -1,
				httpOnly: false,
				secure: false,
				sameSite: 'Lax'
			}];
		}, []);
		config.cookie = authData;
	}
	if ("urls" in config) {
		try {
			config.urls = JSON.parse(config.urls);
		} catch (error) {
			// Try to handle bracket-wrapped URL strings like [https://example.com]
			const bracketMatch = config.urls.trim().match(/^\[(.+)\]$/);
			if (bracketMatch) {
				const urlsContent = bracketMatch[1];
				// Split by comma and trim each URL, then quote them
				const urls = urlsContent.split(',').map((url: string) => url.trim()).filter((url: string) => url.length > 0);
				const quotedUrls = urls.map((url: string) => JSON.stringify(url));
				const jsonArray = `[${quotedUrls.join(',')}]`;
				try {
					config.urls = JSON.parse(jsonArray);
				} catch (parseError) {
					throw new Error(`ERROR: urls is not valid json: ${config.urls}`);
				}
			} else {
				throw new Error(`ERROR: urls is not valid json: ${config.urls}`);
			}
		}
	}
	["authWithoutHost", "networkFilterPatterns"].forEach(key => {
		if (key in config) {
			try {
				config[key] = JSON.parse(config[key]);
			} catch (error) {
				console.error(red(`ERROR: ${key} is not valid json`));
			}
		}
	})

	return {...config, cacheDir: getCacheDirectory()};
}

// Helper function to find element using multiple formats
export async function findElementByMultipleStrategies(page: Page, selectors: string[]): Promise<Locator | null> {
	const getStrategy = (selector: string): string => {
		return /=|-|:/.test(selector) ? `[${selector}]` : selector;
	}

	try {
		const containers = await page.locator(getStrategy(selectors[0])).all();
		if (containers.length === 0) return null;
		if (selectors.length === 1) return containers[0];

		for (const container of containers) {
			const elements = await container.locator(getStrategy(selectors[1])).all();
			if (elements.length > 0) {
				return elements[0];
			}
		}
	} catch (error) {
		console.log(`Error finding element by ${selectors}:`, error);
	}

	return null;
}

/**
 * Take a screenshot of the current page
 * @param page - Playwright page object
 * @param cacheDir - Directory to save screenshots
 * @param options - Screenshot options
 * @returns Object containing screenshot info
 */
export const takeScreenshot = async (page: Page, cacheDir: string, options: ScreenshotOptions = {}): Promise<ScreenshotResult> => {
	try {
		// Ensure cache directory exists
		if (!fs.existsSync(cacheDir)) {
			fs.mkdirSync(cacheDir, { recursive: true });
		}

		// Generate unique filename with timestamp
		const timestamp = Date.now();
		const filename = `screenshot_${timestamp}.png`;
		const filepath = path.resolve(cacheDir, filename);

		let screenshotOptions: any = {
			path: filepath,
			...options
		};

		// Handle element-specific screenshot using action interface logic
		if (options.selector) {
			const element = await findElementByMultipleStrategies(page, options.selector);

			if (!element) {
				console.log(`Element with selector "${options.selector}" not found by any strategy`);
				return {
					success: false,
					error: `Element with selector "${options.selector}" not found`
				};
			}
			await element.screenshot(screenshotOptions);
		} else {
			await page.screenshot(screenshotOptions);
		}

		return {
			success: true,
			filename,
			filepath,
			timestamp,
			url: `/screenshots/${filename}`,
			selector: options.selector || null,
		};
	} catch (error) {
		console.error('Error taking screenshot:', error);
		return {
			success: false,
			error: (error as Error).message
		};
	}
};

/**
 * Clean up old screenshot files
 * @param cacheDir - Directory containing screenshots
 * @param maxAge - Maximum age in milliseconds (default: 24 hours)
 */
export const cleanupScreenshots = (cacheDir: string, maxAge: number = 24 * 60 * 60 * 1000): void => {
	try {
		if (!fs.existsSync(cacheDir)) return;

		const files = fs.readdirSync(cacheDir);
		const now = Date.now();

		files.forEach(file => {
			if (file.startsWith('screenshot_') && file.endsWith('.png')) {
				const filepath = path.resolve(cacheDir, file);
				const stats = fs.statSync(filepath);

				if (now - stats.mtime.getTime() > maxAge) {
					fs.unlinkSync(filepath);
					console.log(`Cleaned up old screenshot: ${file}`);
				}
			}
		});
	} catch (error) {
		console.error('Error cleaning up screenshots:', error);
	}
};

/**
 * Get the default cache directory according to the platform
 * @returns Cache directory
 */
export const getCacheDirectory = (): string => {
	const platform = os.platform();
	const name = `${toolName}-cache`;
	let cacheDir: string;

	// For macOS/Linux, store cache in the home directory
	if (platform === 'darwin' || platform === 'linux') {
		cacheDir = path.join(os.homedir(), '.cache', name);
	}
	// For Windows, store cache in %APPDATA% or %LOCALAPPDATA%
	else if (platform === 'win32') {
		cacheDir = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || os.tmpdir(), name);
	}
	// For other platforms, use a default temp directory
	else {
		cacheDir = path.join(os.tmpdir(), name);
	}

	// Ensure the cache directory exists
	if (!fs.existsSync(cacheDir)) {
		fs.mkdirSync(cacheDir, { recursive: true });
	}

	return cacheDir;
}

export const loadJSONData = (filePath: string): any => {
	try {
		const fullPath = path.resolve(filePath);
		if (!fs.existsSync(fullPath)) {
			console.log(chalk.yellow(`INFO: file not found at ${filePath}`));
			return null;
		}

		const JSONData = JSON.parse(fs.readFileSync(fullPath, 'utf8'));

		return JSONData;
	} catch (error) {
		console.error(red(`INFO: Error loading ${filePath}: ${(error as Error).message}`));
		return null;
	}
}

// Function to open a new terminal window and run the server
export function openInNewWindow(): void {
	const platform = os.platform();
	const scriptPath = process.argv[1];
	const args = process.argv.slice(2).filter(arg => !arg.includes('--newWindow'));
	args.push('--newWindow=false'); // Prevent recursive window opening

	console.log(chalk.blue(`Debug: scriptPath=${scriptPath}`));
	console.log(chalk.blue(`Debug: args=${JSON.stringify(args)}`));
	console.log(chalk.blue(`Debug: platform=${platform}`));

	// Helper function to properly escape arguments for shell
	const escapeArg = (arg: string): string => {
		// If arg contains special characters, spaces, or quotes, wrap in single quotes and escape single quotes
		if (/[\s"'\\$`!*?{}[\]()<>|&;]/.test(arg)) {
			return `'${arg.replace(/'/g, "'\\''")}'`;
		}
		return arg;
	};

	if (platform === 'darwin') {
		// macOS - Use AppleScript to open new Terminal window
		// Properly escape each argument
		const escapedArgs = args.map(escapeArg).join(' ');
		const nodeCommand = `node "${scriptPath}" ${escapedArgs}`;
		console.log(chalk.blue(`Debug: Executing command: ${nodeCommand}`));

		// For AppleScript, we need to escape backslashes and quotes
		const escapedCommand = nodeCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

		const appleScript = `tell application "Terminal"
	activate
	do script "${escapedCommand}"
end tell`;

		console.log(chalk.green('Opening server in new Terminal window...'));

		const child = spawn('osascript', ['-e', appleScript], {
			detached: true,
			stdio: 'ignore'
		});

		child.unref();

		// Give it a moment to spawn
		setTimeout(() => {
			process.exit(0);
		}, 500);
	} else if (platform === 'win32') {
		// Windows - properly escape arguments for cmd.exe
		console.log(chalk.green('Opening server in new Command Prompt window...'));
		const escapedArgs = args.map(arg => {
			// For Windows cmd, wrap in quotes if contains spaces or special chars
			if (/[\s&|<>^]/.test(arg)) {
				return `"${arg.replace(/"/g, '""')}"`;
			}
			return arg;
		});
		const child = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', 'node', scriptPath, ...escapedArgs], {
			detached: true,
			stdio: 'ignore'
		});
		child.unref();
		process.exit(0);
	} else {
		// Linux - try various terminal emulators
		const terminals = ['gnome-terminal', 'konsole', 'xterm'];
		const availableTerminal = terminals.find(term => {
			try {
				require('child_process').execSync(`which ${term}`, { stdio: 'ignore' });
				return true;
			} catch {
				return false;
			}
		});

		if (availableTerminal === 'gnome-terminal') {
			console.log(chalk.green('Opening server in new gnome-terminal window...'));
			// gnome-terminal handles args properly when passed as separate array items
			const child = spawn('gnome-terminal', ['--', 'node', scriptPath, ...args], {
				detached: true,
				stdio: 'ignore'
			});
			child.unref();
		} else if (availableTerminal === 'konsole') {
			console.log(chalk.green('Opening server in new konsole window...'));
			const child = spawn('konsole', ['-e', 'node', scriptPath, ...args], {
				detached: true,
				stdio: 'ignore'
			});
			child.unref();
		} else if (availableTerminal === 'xterm') {
			console.log(chalk.green('Opening server in new xterm window...'));
			const child = spawn('xterm', ['-e', 'node', scriptPath, ...args], {
				detached: true,
				stdio: 'ignore'
			});
			child.unref();
		} else {
			console.error(chalk.red('No supported terminal emulator found. Starting in current window...'));
			return;
		}
		process.exit(0);
	}
}

export const generateDefaultSettings = (cacheDir: string): Partial<MonitorConfig> => {
	const defaultSettings: Settings = require('../public/defaultConfig/defaultSettings.json');
	const authExample: Record<string, AuthAccount> = require('../public/defaultConfig/authExample.json');
	const loginAdaptorsExample = fs.readFileSync(path.resolve(__dirname, "public/defaultConfig/loginAdaptors.js"), "utf-8");
	fs.writeFileSync(path.resolve(cacheDir, "customLoginAdaptors.js"), loginAdaptorsExample);
	defaultSettings.authFilePath.value = path.resolve(cacheDir, "auth.json");
	fs.writeFileSync(path.resolve(cacheDir, "auth.json"), JSON.stringify(authExample, null, 2));
	fs.writeFileSync(path.resolve(cacheDir, "settings.json"), JSON.stringify(defaultSettings, null, 2));
	return Object.entries(defaultSettings).reduce((a, [key, value]) => ({ ...a, [key]: value.value }), {});
}