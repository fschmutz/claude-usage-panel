// One promise around Soup's send_and_read_async. Callers build the message
// (method, headers, body) and map the status to their own outcome; this only
// turns the callback into `{status, bytes}` and a transport failure into a
// rejection.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

/**
 * @param {Soup.Session} session
 * @param {Soup.Message} message
 * @returns {Promise<{status: number, bytes: Uint8Array}>}
 */
export function send(session, message) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (self, result) => {
            try {
                const buf = self.send_and_read_finish(result);
                resolve({status: message.get_status(), bytes: buf.get_data() ?? new Uint8Array(0)});
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** A POST with a JSON body, headers still the caller's to add. */
export function jsonMessage(method, url, body) {
    const message = Soup.Message.new(method, url);
    const payload = new TextEncoder().encode(JSON.stringify(body));
    message.set_request_body_from_bytes('application/json', new GLib.Bytes(payload));
    return message;
}

/** Decode a response body as JSON (throws on garbage, like JSON.parse). */
export function parseBody(bytes) {
    return JSON.parse(new TextDecoder('utf-8').decode(bytes));
}
