// ============================================================
// PrivacyPolicy — the page Google Play will not publish an app without.
//
// WRITTEN FROM THE SCHEMA, NOT FROM A TEMPLATE. Every claim below was
// checked against the live database and the worker source: the columns
// on `users`, what perf_heartbeats and client_crashes actually record,
// which third parties the worker talks to, and what it does NOT keep
// (there is no IP logging anywhere in worker/). A privacy policy that
// overstates is a lie and one that understates is a liability, so if the
// data model changes this page has to change with it.
//
// It also answers, in the same words, the questions Play's Data Safety
// form asks — so the two cannot drift into contradicting each other,
// which is a thing reviewers check.
// ============================================================

import React from 'react';

const UPDATED = '18 September 2026';

export const PrivacyPolicy: React.FC = () => (
  <section className="landing-doc">
    <h1 className="doc-title">Privacy Policy</h1>
    <div className="doc-updated">Last updated {UPDATED}</div>

    <p className="doc-lede">
      Orbital is a multiplayer strategy game. It keeps the least it can: enough to
      know who you are between sessions, to run the games you are in, and to keep
      the thing from falling over. It is not funded by advertising and your data is
      not sold, rented, or shared for marketing.
    </p>

    <h2>What is stored, and why</h2>

    <h3>Your account</h3>
    <p>
      An email address, a display name, and either a password (stored only as a
      salted PBKDF2 hash, never as text) or an identifier from Google if you sign
      in that way. This is what lets you come back to your empire. If you link
      Discord, your Discord ID and username are stored so the game can reach you
      there and so slash commands know who you are.
    </p>

    <h3>Your games</h3>
    <p>
      Everything you do in a match — fleets, worlds, trades, senate votes, messages
      to other players — is stored so the game can run. Messages between factions
      are visible to their recipients and, where the game says so, to spectators of
      a finished match. Treat in-game chat as in-game, not as private
      correspondence.
    </p>

    <h3>Sessions</h3>
    <p>
      A session token in a cookie, with the browser user-agent string and when it
      was last used, so you stay signed in for thirty days and can see if something
      looks wrong. The cookie is strictly necessary to play; there are no
      advertising or tracking cookies.
    </p>

    <h3>Performance and crash reports</h3>
    <p>
      The game records how well it is running: frame rates, memory, screen size,
      graphics adapter, processor count, and the browser user-agent. When the
      interface crashes it records the error and the code path that caused it. This
      is used to find bugs — a slow frame on a particular phone is usually the only
      evidence a problem exists. It is tied to your account so we can tell one
      device from another, and it is never used to build a profile of you.
    </p>

    <h3>Notifications</h3>
    <p>
      If you turn on notifications, your browser gives us an address on its own
      push service plus two keys used to encrypt messages to it. We use them only
      to send Orbital notifications. Turn them off in the game and the record is
      deleted; uninstall or revoke permission and it is deleted the next time a
      notification fails to reach you.
    </p>

    <h3>Purchases</h3>
    <p>
      The Commander&rsquo;s Commission is sold on this website through Stripe.
      Stripe handles the payment; Orbital never sees or stores your card details.
      We keep a record that your account owns the Commission. Purchases are not
      available in the Android app.
    </p>

    <h2>What is NOT stored</h2>
    <ul>
      <li>No IP address logging.</li>
      <li>No advertising identifiers, no ad networks, no third-party analytics.</li>
      <li>No location beyond what a time zone implies.</li>
      <li>No contacts, photos, files, microphone, or camera.</li>
      <li>No card numbers.</li>
    </ul>

    <h2>Who else is involved</h2>
    <p>
      Orbital runs on Cloudflare, which hosts the site and the database.
      Stripe processes payments. Google provides optional sign-in, and delivers
      push notifications to Android devices. Discord is optional and only if you
      link it. Each of these sees only what it needs to do its job.
    </p>

    <h2>How long it is kept</h2>
    <p>
      Account and game data are kept while your account exists, because a strategy
      game that forgot your empire would not be much of one. Sessions expire after
      thirty days. Performance and crash records are kept while they are useful for
      debugging and are not needed to identify you.
    </p>

    <h2>Deleting your account</h2>
    <p>
      Email the address below and your account and personal data will be deleted.
      Games you have already played may keep an anonymised record — other players&rsquo;
      match histories would otherwise develop holes — but it will no longer be
      connected to you.
    </p>

    <h2>Children</h2>
    <p>
      Orbital is not directed at children under 13, and accounts are not knowingly
      created for them. If you believe a child has created an account, write to us
      and it will be removed.
    </p>

    <h2>Changes</h2>
    <p>
      If this policy changes in a way that affects what is collected, the date at
      the top changes and the change is noted in the game&rsquo;s changelog.
    </p>

    <h2>Contact</h2>
    <p>
      Questions, deletion requests, or anything else:{' '}
      <a className="doc-link" href="mailto:privacy@orbital-empire.com">
        privacy@orbital-empire.com
      </a>
    </p>
  </section>
);
