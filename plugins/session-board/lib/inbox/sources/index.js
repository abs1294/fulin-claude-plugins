'use strict';
// The sources the inbox can fetch from. To add one: write lib/inbox/sources/<id>.js in the shape described at
// the top of gmail.js, and name it in the list below. Nothing else in the server needs to know its name:
// the settings, the switches, the cards of the page and the route form are all made from this list.
const list = [require('./gmail'), require('./slack'), require('./teams')];
const ids = list.map((x) => x.id);
const byId = (id) => list.find((x) => x.id === id) || null;
const gmail = byId('gmail'), teams = byId('teams'), slack = byId('slack');

module.exports = { list, ids, byId,
  // by name, for the callers that mean one source in particular (handing over a mail's attachments, the tests)
  safeName: gmail.safeName, gmailAttachments: gmail.gmailAttachments, pollGmail: gmail.pollGmail, gmailConfigured: gmail.gmailConfigured, gmailBody: gmail.gmailBody, ReauthError: gmail.ReauthError,
  pollSlack: slack.pollSlack, pollTeams: teams.pollTeams, guessTeamsSelf: teams.guessTeamsSelf };
