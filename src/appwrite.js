// replace your current appwrite imports with these:
const { Client, Databases, Storage, Users, ID, Query } = require('node-appwrite');
const { InputFile } = require('node-appwrite/file'); // <-- important





const client = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);
const storage = new Storage(client);
const users = new Users(client);

const DB_ID = process.env.APPWRITE_DATABASE_ID;
const MEMBERSHIPS = process.env.APPWRITE_MEMBERSHIPS_ID;
const LOGS = process.env.APPWRITE_LOGS_ID;
const PHOTO_BUCKET = process.env.APPWRITE_PHOTO_BUCKET_ID;

function pad6(n) {
    return String(n).padStart(6, '0');
}
function todayStr() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}

/** Paginate through Appwrite Auth users to find the largest 6-digit prefix before @skygym.local */
async function getMaxEmailNumber() {
    let max = 0;
    let cursor = null;
    while (true) {
        const queries = [Query.limit(100)];
        if (cursor) queries.push(Query.cursorAfter(cursor));
        const page = await users.list(queries);
        for (const u of page.users) {
            // emails like 000123@skygym.local
            const m = /^(\d{6})@skygym\.local$/i.exec(u.email || '');
            if (m) {
                const num = parseInt(m[1], 10);
                if (num > max) max = num;
            }
        }
        if (!page.total || page.users.length < 100) break;
        cursor = page.users[page.users.length - 1].$id;
    }
    return max;
}

/** Create Auth user with next number + upload photo to Storage (fileId = NNNNNN) */
async function createAuthUserWithPhoto({ password, name, photoBuffer, photoFilename }) {
    const next = (await getMaxEmailNumber()) + 1;
    const numberStr = pad6(next);
    const email = `${numberStr}@skygym.local`;

    // 1) Create Appwrite Auth user
    const user = await users.create(ID.unique(), email, undefined, password, name || email);

    // delete old photo if exists (ignore if not found)
    try { await storage.deleteFile(PHOTO_BUCKET, numberStr); } catch (_) { }

    const file = InputFile.fromBuffer(
        Buffer.isBuffer(photoBuffer) ? photoBuffer : Buffer.from(photoBuffer),
        `${numberStr}.jpg`
    );

    await storage.createFile(PHOTO_BUCKET, numberStr, file);






    return { user, number: next, email, numberStr };
}

/** Membership helpers (from previous step) */
async function getLatestMembership(user_id) {
    const res = await databases.listDocuments(DB_ID, MEMBERSHIPS, [
        Query.equal('user_id', user_id),
        Query.orderDesc('endAt'),
        Query.limit(1)
    ]);
    return res.total ? res.documents[0] : null;
}
function isMembershipActive(m) {
    if (!m) return false;
    const ends = new Date(m.endAt).getTime();
    return m.status === 'active' && ends >= Date.now();
}
async function createMembership({ user_id, status = 'active', startAt, endAt }) {
    return databases.createDocument(DB_ID, MEMBERSHIPS, ID.unique(), { user_id, status, startAt, endAt, location: 'skygym' });
}
async function createMonthlyMembership({ user_id, months = 1 }) {
    const start = new Date();
    const end = new Date(start);
    end.setMonth(end.getMonth() + Number(months || 1));
    return createMembership({ user_id, status: 'active', startAt: start.toISOString(), endAt: end.toISOString() });
}
async function createDailyPass({ user_id }) {
    const start = new Date();
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return createMembership({ user_id, status: 'active', startAt: start.toISOString(), endAt: end.toISOString() });
}

/** Photo URL for member (fileId = user_id) */
function getPhotoUrl(user_id) {
    return storage.getFileView(PHOTO_BUCKET, String(user_id));
}

/** Logs */
async function findOpenLog(user_id) {
    const res = await databases.listDocuments(DB_ID, LOGS, [
        Query.equal('user_id', user_id),
        Query.equal('date', todayStr()),
        Query.isNull('checkoutTime'),
        Query.limit(1)
    ]);
    return res.total ? res.documents[0] : null;
}
function getMinutesSinceMidnight() {
    const now = new Date();
    const options = { timeZone: 'Asia/Beirut', hour: '2-digit', minute: '2-digit', hour12: false };
    const parts = new Intl.DateTimeFormat('en-GB', options).formatToParts(now);
    const hours = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const minutes = parseInt(parts.find(p => p.type === 'minute').value, 10);
    return hours * 60 + minutes;
}


async function createCheckIn(user_id) {
    const nowMinutes = getMinutesSinceMidnight();
    const doc = await databases.createDocument(DB_ID, LOGS, ID.unique(), {
        user_id,
        date: todayStr(),
        checkInTime: nowMinutes
    });
    return { action: 'checkin', doc };
}

async function closeCheckOut(openLog) {
    const outMinutes = getMinutesSinceMidnight();
    const minsWorked = Math.max(0, outMinutes - (openLog.checkInTime || outMinutes));
    const updated = await databases.updateDocument(DB_ID, LOGS, openLog.$id, {
        checkoutTime: outMinutes,
        workedMinutes: minsWorked
    });
    return { action: 'checkout', doc: updated };
}


module.exports = {
    client,
    databases,
    storage,
    users,
    // create user
    createAuthUserWithPhoto,
    getMaxEmailNumber,
    // membership
    getLatestMembership,
    isMembershipActive,
    createMonthlyMembership,
    createDailyPass,
    createMembership,
    // photos
    getPhotoUrl,
    // logs
    findOpenLog,
    createCheckIn,
    closeCheckOut,
};
