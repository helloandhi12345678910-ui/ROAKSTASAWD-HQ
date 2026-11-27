/* ROAKSTASAWD HQ — backend settings
 *
 * Put your Firebase Realtime Database URL between the quotes below.
 * The site switches to the shared backend as soon as this is filled in;
 * while it says YOUR-PROJECT it works offline, on one device.
 *
 * Where to find the URL: Firebase console -> Build -> Realtime Database ->
 * the URL at the top of the data tab, e.g.
 *     https://fr-roak-hq-fr-default-rtdb.firebaseio.com
 * (a database outside us-central1 ends in .REGION.firebasedatabase.app)
 *
 * If you use a different backend that reads and writes a JSON document at
 * <url>/hq.json with plain GET and PUT, only "url" needs to change.
 */

window.ROAK_BACKEND = {
  url: 'https://fr-roak-hq-fr-default-rtdb.firebaseio.com'
};
