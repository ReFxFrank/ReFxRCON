// How players get into a WARDOGS server: the game's own browser, by list or by join code. The
// game publishes no address and answers no Steam server query, so steam://connect and +connect
// can never work; the most a link can do is launch the game. Pure.

export const WARDOGS_APP_ID = 1867240;

/** Launches WARDOGS through Steam; the join code is then entered in the server browser. */
export const steamLaunchLink = (appId = WARDOGS_APP_ID): string => `steam://rungameid/${appId}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A community server's join code is a UUID; official servers use a short number where leading
 * zeros count. Whitespace is dropped, letters lower-cased; blank clears.
 */
export function validateJoinCode(raw: unknown): string {
	const text = String(raw ?? '')
		.replace(/\s+/g, '')
		.toLowerCase();
	if (!text) return '';
	if (UUID.test(text) || /^\d{1,12}$/.test(text)) return text;
	throw new Error(
		'The join code is the 36-character code (letters, digits and dashes) the server browser shows for the server, or the short number of an official server.'
	);
}
