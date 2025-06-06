const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const { Pool } = require('pg');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs'); // Required for file system operations (like deleting temp files)

const app = express();
const port = 3000;

// --- Database Configuration ---
// Consider using environment variables for sensitive data
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'youtube_db',
    password: 'postgres', // Change to your PostgreSQL password
    port: 5432,
});

// --- Multer Configuration ---
const UPLOAD_DIR = 'uploads/';
// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)){
    fs.mkdirSync(UPLOAD_DIR);
}
const upload = multer({ dest: UPLOAD_DIR });

// --- View Engine Setup ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- Middleware ---
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public')); // Serve static files from 'public' directory

// --- Table Name Constants ---
const DHUN_DATA_TABLE = 'dhun_dashboard_data';
const KIRTAN_DATA_TABLE = 'kirtan_dashboard_data'; // New table for Kirtan
const DHUN_PLAYLIST_TABLE = 'dhun_playlist';
const KIRTAN_PLAYLIST_TABLE = 'kirtan_playlist'; // New table for Kirtan Playlist
const STREAMED_DHUN_TABLE = 'streamed_dhun_table';
const LYRICAL_DHUN_TABLE = 'lyrical_video_dhun_table';
const DHUN_JUKEBOX_TABLE = 'dhun_jukebox_table';
const STREAMED_KIRTAN_TABLE = 'streamed_kirtan_table'; // New specific kirtan table
const LYRICAL_KIRTAN_TABLE = 'lyrical_video_kirtan_table'; // New specific kirtan table
const KIRTAN_JUKEBOX_TABLE = 'kirtan_jukebox_table'; // New specific kirtan table
const VIDEO_FILTERS_TABLE = 'video_filters';
const VIDEOS_TABLE = 'videos';
const PLAYLISTS_TABLE = 'playlists';
const TYPES_TABLE = 'types'; // Renamed constant
const CATEGORIES_TABLE = 'categories'; // Renamed constant (now refers to the former sub_categories)
const KATHA_DETAILS_TABLE = 'katha_details';


// --- Helper Function: Clean up uploaded file ---
function cleanupFile(filePath) {
    fs.unlink(filePath, (err) => {
        if (err) {
            console.error(`Error deleting temporary file ${filePath}:`, err);
        } else {
            console.log(`Deleted temporary file: ${filePath}`);
        }
    });
}

// --- Helper Function: Export Data to Excel ---
async function exportToExcel(res, query, filename, queryParams = []) {
    let client; // Define client outside try block
    try {
        client = await pool.connect();
        const result = await client.query(query, queryParams);


        if (result.rows.length === 0) {
            return res.status(404).send('No data to export.');
        }

        const worksheet = xlsx.utils.json_to_sheet(result.rows);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Data');

        // Set headers for file download
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);

        // Send the workbook buffer
        const buffer = xlsx.write(workbook, { bookType: 'xlsx', type: 'buffer' });
        res.send(buffer);

    } catch (error) {
        console.error('Export error:', error);
        res.status(500).send('Error exporting data.');
    } finally {
        if (client) {
             client.release(); // Ensure client is released
        }
    }
}

// --- Core Data Refresh Functions ---

/**
 * Refreshes derived tables storing specific types of Dhun videos.
 * @param {pg.Client} client - The PostgreSQL client.
 */
async function refreshSpecificDhunTables(client) {
    console.log('Refreshing specific dhun tables...');
    try {
        // These tables now inherit structure from dhun_dashboard_data, including playlist columns
        const tablesToRefresh = [
            // Conditions updated to use 'type_name' and 'category_name'
            { name: STREAMED_DHUN_TABLE, condition: "LOWER(type_name) LIKE '%streamed dhun%' OR LOWER(category_name) LIKE '%streamed dhun%'" },
            { name: LYRICAL_DHUN_TABLE, condition: "LOWER(type_name) LIKE '%lyrical video%' OR LOWER(category_name) LIKE '%lyrical video%'" },
            { name: DHUN_JUKEBOX_TABLE, condition: "LOWER(type_name) LIKE '%dhun jukebox%' OR LOWER(category_name) LIKE '%dhun jukebox%'" }
        ];

        for (const table of tablesToRefresh) {
            await client.query(`DROP TABLE IF EXISTS ${table.name}`);
            // Create table based on the main dhun data table structure and filter
            await client.query(`
                CREATE TABLE ${table.name} AS
                SELECT * FROM ${DHUN_DATA_TABLE}
                WHERE ${table.condition}
            `);
            console.log(`${table.name} refreshed.`);
        }
    } catch (error) {
        console.error('Error refreshing specific dhun tables:', error);
        throw error; // Re-throw error to be caught by caller
    }
}

/**
 * Refreshes the main Dhun dashboard data table by querying the core video tables.
 * @param {pg.Client} client - The PostgreSQL client.
 */
async function refreshDhunDashboardData(client) {
    console.log('Refreshing dhun dashboard data...');
    try {
        // Clear the existing data
        await client.query(`DELETE FROM ${DHUN_DATA_TABLE}`);

        // Re-populate with latest data, including playlist info and video DB ID
        // Query updated to join with 'types' and 'categories' tables and select 'type_name' and 'category_name'
        const query = `
            INSERT INTO ${DHUN_DATA_TABLE} (
                video_db_id, video_id, video_title, channel_id,
                type_name, category_name, playlist_id, playlist_name -- Adjusted column names
            )
            SELECT
                v.id AS video_db_id, -- Include the video's primary key
                v.video_id,
                v.video_title,
                v.channel_id,
                t.type_name,       -- Get type name from types table
                c.category_name,   -- Get category name from categories table
                v.playlist_id,
                p.playlist_name
            FROM ${VIDEOS_TABLE} v
            LEFT JOIN ${TYPES_TABLE} t ON v.type_id = t.type_id -- Join with types table
            LEFT JOIN ${CATEGORIES_TABLE} c ON v.category_id = c.category_id -- Join with categories table
            LEFT JOIN ${PLAYLISTS_TABLE} p ON v.playlist_id = p.playlist_id
            LEFT JOIN ${KATHA_DETAILS_TABLE} k ON v.id = k.video_id
            WHERE
                (
                    LOWER(t.type_name) LIKE '%dhun%' OR         -- Check type name
                    LOWER(c.category_name) LIKE '%dhun%' OR     -- Check category name
                    t.type_name = 'Dhun Jukebox' OR             -- Check type name for specific value
                    LOWER(k.granth_name) LIKE '%dhun%'
                )
                AND LOWER(t.type_name) NOT LIKE '%kirtan/instrumental/dhun%' -- Exclude based on type name
                AND LOWER(c.category_name) NOT LIKE '%kirtan/instrumental/dhun%' -- Exclude based on category name
            ORDER BY v.video_title ASC;
        `;
        await client.query(query);
        const countResult = await client.query(`SELECT COUNT(*) FROM ${DHUN_DATA_TABLE}`);
        console.log(`Dhun dashboard data refreshed successfully. Total rows in ${DHUN_DATA_TABLE}: ${countResult.rows[0].count}`);



        // Refresh the specific dhun tables based on the newly populated dashboard data
        await refreshSpecificDhunTables(client);

        // Now generate the playlist using the refreshed data
        await generateDhunPlaylist(client);

    } catch (error) {
        console.error('Error refreshing dhun dashboard data:', error);
        throw error; // Re-throw error
    }
}

/**
 * Generates the Dhun playlist based on specific rules and refreshed data.
 * @param {pg.Client} client - The PostgreSQL client.
 */
async function generateDhunPlaylist(client) {
    console.log('Generating dhun playlist...');
    try {
        // Drop existing playlist table
        await client.query(`DROP TABLE IF EXISTS ${DHUN_PLAYLIST_TABLE}`);

        // Create the playlist table structure (including new columns with adjusted names)
        await client.query(`
            CREATE TABLE ${DHUN_PLAYLIST_TABLE} (
                id SERIAL PRIMARY KEY,
                video_db_id INTEGER NOT NULL,
                video_id VARCHAR(255) NOT NULL,
                video_title VARCHAR(255) NOT NULL,
                channel_id VARCHAR(255),
                type_name VARCHAR(255),     -- Renamed from category_name
                category_name VARCHAR(255), -- Renamed from sub_category_name
                playlist_id TEXT,
                playlist_name TEXT,
                playlist_order INTEGER NOT NULL,
                FOREIGN KEY (video_db_id) REFERENCES videos(id) ON DELETE CASCADE
            )
        `);

        // Fetch data from the refreshed specific dhun tables
        const streamedRes = await client.query(`SELECT * FROM ${STREAMED_DHUN_TABLE}`);
        const lyricalRes = await client.query(`SELECT * FROM ${LYRICAL_DHUN_TABLE}`);
        const jukeboxRes = await client.query(`SELECT * FROM ${DHUN_JUKEBOX_TABLE}`);

        let streamed = streamedRes.rows;
        let lyrical = lyricalRes.rows;
        let jukebox = jukeboxRes.rows; // Renamed for clarity

        // Handle cases where source arrays might be empty
        if (streamed.length === 0) {
            console.log('No streamed dhun videos available for playlist generation. Playlist will be empty.');
            return; // Exit if no base videos
        }

        // Shuffle function
        const shuffleArray = (array) => {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
        };

        // Shuffle the arrays
        shuffleArray(streamed);
        shuffleArray(lyrical);
        shuffleArray(jukebox); // Shuffle jukebox too if needed

        let playlist = [];
        let streamIndex = 0, lyricalIndex = 0, jukeboxIndex = 0;
        let order = 1;

        // Helper to get next item safely, cycling through the array
        const getNextItem = (arr, index) => {
            if (!arr || arr.length === 0) return null; // Return null if array is empty
            return arr[index % arr.length];
        };

        // Playlist generation logic (remains the same, just using different data sources)
        while (streamIndex < streamed.length) {
            // Repeat 4 times: 4 streamed + 1 lyrical (if available)
            for (let repeat = 0; repeat < 4; repeat++) {
                // Add 4 streamed videos
                for (let i = 0; i < 4 && streamIndex < streamed.length; i++) {
                    const item = streamed[streamIndex++];
                    playlist.push({ ...item, playlist_order: order++ });
                }
                // Add 1 lyrical video (if available)
                const lyricalItem = getNextItem(lyrical, lyricalIndex++);
                if (lyricalItem) { // Only add if lyrical video exists
                    playlist.push({ ...lyricalItem, playlist_order: order++ });
                }
            }

            // Then add 1 jukebox video (if available)
            const jukeboxItem = getNextItem(jukebox, jukeboxIndex++);
            if (jukeboxItem) { // Only add if jukebox video exists
                playlist.push({ ...jukeboxItem, playlist_order: order++ });
            }
        }

        // Insert the generated playlist into the database
        for (const video of playlist) {
             // Ensure all expected fields exist, provide defaults if necessary
            const videoDbId = video.video_db_id; // Should exist now
            const videoId = video.video_id || '';
            const videoTitle = video.video_title || 'Untitled';
            const channelId = video.channel_id || null;
            const typeName = video.type_name || null;     // Use typeName
            const categoryName = video.category_name || null; // Use categoryName
            const playlistId = video.playlist_id || null;
            const playlistName = video.playlist_name || null;
            const playlistOrder = video.playlist_order;

            if (!videoDbId) {
                console.warn(`Skipping playlist entry due to missing video_db_id for video_id: ${videoId}`);
                continue;
            }

            // Updated INSERT query to match new column names
            await client.query(
                `INSERT INTO ${DHUN_PLAYLIST_TABLE} (
                    video_db_id, video_id, video_title, channel_id, type_name,
                    category_name, playlist_id, playlist_name, playlist_order
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                    videoDbId, videoId, videoTitle, channelId, typeName,
                    categoryName, playlistId, playlistName, playlistOrder
                ]
            );
        }
        const playlistCountResult = await client.query(`SELECT COUNT(*) FROM ${DHUN_PLAYLIST_TABLE}`);
        console.log(`Dhun Playlist Generated. Total rows in ${DHUN_PLAYLIST_TABLE}: ${playlistCountResult.rows[0].count}`);


    } catch (error) {
        console.error('Error generating Dhun Playlist:', error);
        throw error;
    }
}


/**
 * Refreshes the main Kirtan dashboard data table by querying the core video tables.
 * @param {pg.Client} client - The PostgreSQL client.
 */
async function refreshKirtanDashboardData(client) {
    console.log('Refreshing kirtan dashboard data...');
    try {
        // Clear the existing data
        await client.query(`DELETE FROM ${KIRTAN_DATA_TABLE}`);

        // Re-populate with latest data, including playlist info and video DB ID
        const query = `
            INSERT INTO ${KIRTAN_DATA_TABLE} (
                video_db_id, video_id, video_title, channel_id,
                type_name, category_name, playlist_id, playlist_name
            )
            SELECT
                v.id AS video_db_id,
                v.video_id,
                v.video_title,
                v.channel_id,
                t.type_name,
                c.category_name,
                v.playlist_id,
                p.playlist_name
            FROM ${VIDEOS_TABLE} v
            LEFT JOIN ${TYPES_TABLE} t ON v.type_id = t.type_id
            LEFT JOIN ${CATEGORIES_TABLE} c ON v.category_id = c.category_id
            LEFT JOIN ${PLAYLISTS_TABLE} p ON v.playlist_id = p.playlist_id
            WHERE
                (
                    LOWER(t.type_name) LIKE '%kirtan%' OR
                    LOWER(c.category_name) LIKE '%kirtan%'
                )
            ORDER BY v.video_title ASC;
        `;
        await client.query(query);
        const countResult = await client.query(`SELECT COUNT(*) FROM ${KIRTAN_DATA_TABLE}`);
        console.log(`Kirtan dashboard data refreshed successfully. Total rows in ${KIRTAN_DATA_TABLE}: ${countResult.rows[0].count}`);

        // Refresh the specific kirtan tables based on the newly populated dashboard data
        await refreshSpecificKirtanTables(client);
        // console.log(`Kirtan dashboard data refreshed successfully. Total rows in ${KIRTAN_DATA_TABLE}: ${countResult.rows[0].count}`); // Duplicate log
    } catch (error) {
        console.error('Error refreshing kirtan dashboard data:', error);
        throw error; // Re-throw error
    }
}

/**
 * Refreshes derived tables storing specific types of Kirtan videos.
 * @param {pg.Client} client - The PostgreSQL client.
 */
async function refreshSpecificKirtanTables(client) {
    console.log('Refreshing specific kirtan tables...');
    try {
        // Define your kirtan categories and their conditions here.
        // These are examples; you'll need to adjust them based on your data.
        // IMPORTANT: Update these conditions to match your actual data structure for kirtan types/categories.
         const tablesToRefresh = [
            { name: STREAMED_KIRTAN_TABLE, condition: "LOWER(type_name) LIKE '%kirtan%' AND LOWER(category_name) LIKE '%streamed kirtan%'" },
            { name: LYRICAL_KIRTAN_TABLE, condition: "LOWER(type_name) LIKE '%kirtan%' AND LOWER(category_name) LIKE '%lyrical video%'" }, // Adjust condition as needed
            { name: KIRTAN_JUKEBOX_TABLE, condition: "LOWER(type_name) LIKE '%kirtan%' AND LOWER(category_name) LIKE '%kirtan jukebox%'" }
        ];

        for (const table of tablesToRefresh) {
            await client.query(`DROP TABLE IF EXISTS ${table.name}`);
            // Create table based on the main kirtan data table structure and filter
            // It's important that these tables select from KIRTAN_DATA_TABLE
            await client.query(`
                CREATE TABLE ${table.name} AS
                SELECT * FROM ${KIRTAN_DATA_TABLE}
                WHERE ${table.condition}
            `);
            const countResult = await client.query(`SELECT COUNT(*) FROM ${table.name}`);
            console.log(`${table.name} refreshed. Rows: ${countResult.rows[0].count}`);
        }
    } catch (error) {
        console.error('Error checking database:', error);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/upload', (req, res) => {
    res.render('index');
});

/**
 * Generates the Kirtan playlist based on refreshed Kirtan dashboard data.
 * @param {pg.Client} client - The PostgreSQL client.
 */
async function generateKirtanPlaylist(client) {
    console.log('Generating kirtan playlist...');
    try {
        // Drop existing playlist table
        await client.query(`DROP TABLE IF EXISTS ${KIRTAN_PLAYLIST_TABLE}`);

        // Create the playlist table structure (mirroring dhun_playlist structure)
        await client.query(`
            CREATE TABLE ${KIRTAN_PLAYLIST_TABLE} (
                id SERIAL PRIMARY KEY,
                video_db_id INTEGER NOT NULL,
                video_id VARCHAR(255) NOT NULL,
                video_title VARCHAR(255) NOT NULL,
                channel_id VARCHAR(255),
                type_name VARCHAR(255),
                category_name VARCHAR(255),
                playlist_id TEXT,
                playlist_name TEXT,
                playlist_order INTEGER NOT NULL,
                FOREIGN KEY (video_db_id) REFERENCES videos(id) ON DELETE CASCADE
            )
        `);

        // Fetch data from the refreshed specific kirtan tables
        const liveKirtanRes = await client.query(`SELECT * FROM ${STREAMED_KIRTAN_TABLE}`);
        const studioKirtanRes = await client.query(`SELECT * FROM ${LYRICAL_KIRTAN_TABLE}`);
        const instrumentalKirtanRes = await client.query(`SELECT * FROM ${KIRTAN_JUKEBOX_TABLE}`);

        let liveKirtans = liveKirtanRes.rows;
        let studioKirtans = studioKirtanRes.rows;
        let instrumentalKirtans = instrumentalKirtanRes.rows;

        if (liveKirtans.length === 0) {
            console.log(`No live kirtan videos available from ${LIVE_KIRTAN_TABLE} for playlist generation. Kirtan playlist might be empty or sparsely populated.`);
            if (studioKirtans.length === 0 && instrumentalKirtans.length === 0) {
                 console.log('All specific kirtan categories are empty. Kirtan playlist will be empty.');
                 return;
            }
        }

        const shuffleArray = (array) => {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
        };

        shuffleArray(liveKirtans);
        shuffleArray(studioKirtans);
        shuffleArray(instrumentalKirtans);

        let playlist = [];
        let liveIndex = 0, studioIndex = 0, instrumentalIndex = 0;
        let order = 1; // This 'order' is for assigning playlist_order

        const getNextItem = (arr, index) => {
            if (!arr || arr.length === 0) return null;
            return arr[index % arr.length];
        };

        // Apply Dhun-like playlist generation logic
        while (liveIndex < liveKirtans.length) {
            // Repeat 4 times: 4 live + 1 studio (if available)
            for (let repeat = 0; repeat < 4; repeat++) {
                // Add 4 live kirtans
                for (let i = 0; i < 4 && liveIndex < liveKirtans.length; i++) {
                    const item = liveKirtans[liveIndex++];
                    playlist.push({ ...item, playlist_order: order++ });
                }
                // Add 1 studio kirtan (if available)
                const studioItem = getNextItem(studioKirtans, studioIndex++);
                if (studioItem) {
                    playlist.push({ ...studioItem, playlist_order: order++ });
                }
            }

            // Then add 1 instrumental kirtan (if available)
            const instrumentalItem = getNextItem(instrumentalKirtans, instrumentalIndex++);
            if (instrumentalItem) {
                playlist.push({ ...instrumentalItem, playlist_order: order++ });
            }
        }
        
        // Fallback: if no live kirtans but other types exist, or if the loop didn't populate enough
        // and other kirtans are still available.
        if (playlist.length === 0 && (studioKirtans.length > 0 || instrumentalKirtans.length > 0)) {
            console.log("No live kirtans or main loop didn't run, but other kirtan types exist. Populating with available kirtans.");
            let remainingKirtans = [];
            if (studioKirtans.length > 0) remainingKirtans.push(...studioKirtans);
            if (instrumentalKirtans.length > 0) remainingKirtans.push(...instrumentalKirtans);
            
            // Filter out already added items if any (though unlikely if playlist.length is 0)
            const playlistVideoIds = new Set(playlist.map(v => v.video_id));
            remainingKirtans = remainingKirtans.filter(v => !playlistVideoIds.has(v.video_id));

            shuffleArray(remainingKirtans);
            for(const item of remainingKirtans) {
                playlist.push({ ...item, playlist_order: order++ });
            }
        }


        if (playlist.length === 0) {
            console.log('Kirtan playlist is empty after attempting pattern generation.');
            return;
        }

        for (const video of playlist) {
            if (!video.video_db_id) {
                console.warn(`Skipping kirtan playlist entry due to missing video_db_id for video_id: ${video.video_id}`);
                continue;
            }
            await client.query(
                `INSERT INTO ${KIRTAN_PLAYLIST_TABLE} (
                    video_db_id, video_id, video_title, channel_id, type_name,
                    category_name, playlist_id, playlist_name, playlist_order
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                    video.video_db_id, video.video_id, video.video_title, video.channel_id,
                    video.type_name, video.category_name, video.playlist_id, video.playlist_name, video.playlist_order
                ]
            );
        }
        const playlistCountResult = await client.query(`SELECT COUNT(*) FROM ${KIRTAN_PLAYLIST_TABLE}`);
        console.log(`Kirtan Playlist Generated. Total rows in ${KIRTAN_PLAYLIST_TABLE}: ${playlistCountResult.rows[0].count}`);
    } catch (error) {
        console.error('Error generating Kirtan Playlist:', error);
        throw error;
    }
}



/**
 * Applies exclusion filters from the database to the uploaded data.
 * @param {Array} data - The video data extracted from the Excel file.
 * @param {pg.Client} client - The PostgreSQL client.
 * @returns {Promise<Array>} - The filtered data (items that were *not* excluded).
 */
async function applyFilters(data, client) {
    console.log('Applying filters (will update is_active=false for matches)...');
    try {
        const filterResults = await client.query(`SELECT * FROM ${VIDEO_FILTERS_TABLE}`);
        const filters = filterResults.rows;

        if (filters.length === 0) {
            console.log('No filters found in database. No updates performed.');
            return;
        }

        for (const item of data) {
            let shouldDeactivate = false;

            for (const filter of filters) {
                const filterType = filter.filter_type;
                const filterValue = filter.filter_value?.toLowerCase();
                let itemValue = null;

                switch (filterType) {
                    case 'video_id':
                        itemValue = item['Video Id'];
                        if (itemValue !== null && itemValue !== undefined && filter.filter_value && itemValue === filter.filter_value) {
                            shouldDeactivate = true;
                        }
                        break;
                    case 'video_title':
                        itemValue = item['Video Title']?.toLowerCase();
                        if (itemValue !== null && itemValue !== undefined && filterValue && itemValue.includes(filterValue)) {
                            shouldDeactivate = true;
                        }
                        break;
                    case 'playlist_id':
                        itemValue = item['Playlist Id'];
                        if (itemValue !== null && itemValue !== undefined && filter.filter_value && itemValue === filter.filter_value) {
                            shouldDeactivate = true;
                        }
                        break;
                    case 'playlist_name':
                        itemValue = item['Playlist Name']?.toLowerCase();
                        if (itemValue !== null && itemValue !== undefined && filterValue && itemValue.includes(filterValue)) {
                            shouldDeactivate = true;
                        }
                        break;
                    case 'privacy_status':
                        itemValue = item['Privacy Status']?.toLowerCase();
                        if (itemValue !== null && itemValue !== undefined && filterValue && itemValue === filterValue) {
                            shouldDeactivate = true;
                        }
                        break;
                    case 'Type':
                        const typeFromDescription = (item['Description']?.match(/Type:\s*([^\n<]+)/) || [])[1]?.trim()?.toLowerCase();
                        const typeFromColumn = item['Type']?.toLowerCase();
                        itemValue = typeFromColumn || typeFromDescription;
                        if (itemValue !== null && itemValue !== undefined && filterValue && itemValue.includes(filterValue)) {
                            shouldDeactivate = true;
                        }
                        break;
                    case 'Category':
                        const categoryFromDescription = (item['Description']?.match(/Category:\s*([^\n<]+)/) || [])[1]?.trim()?.toLowerCase();
                        const categoryFromColumn = item['Category']?.toLowerCase();
                        itemValue = categoryFromColumn || categoryFromDescription;
                        if (itemValue !== null && itemValue !== undefined && filterValue && itemValue.includes(filterValue)) {
                            shouldDeactivate = true;
                        }
                        break;
                    case 'Orator':
                        const oratorFromDescription = (item['Description']?.match(/Orator:\s*([^\n<]+)/) || [])[1]?.trim()?.toLowerCase();
                        const oratorFromColumn = item['Orator']?.toLowerCase();
                        itemValue = oratorFromColumn || oratorFromDescription;
                        if (itemValue !== null && itemValue !== undefined && filterValue && itemValue.includes(filterValue)) {
                            shouldDeactivate = true;
                        }
                        break;
                    case 'Sabha Number/Track Number':
                        const sabhaFromDescription = parseInt((item['Description']?.match(/Sabha Number:\s*(\d+)/) || [])[1]);
                        const sabhaFromColumn = parseInt(item['Sabha Number']);
                        itemValue = !isNaN(sabhaFromColumn) ? sabhaFromColumn : (!isNaN(sabhaFromDescription) ? sabhaFromDescription : null);
                        const filterSabhaNumber = parseInt(filter.filter_value);
                        if (itemValue !== null && !isNaN(filterSabhaNumber) && itemValue === filterSabhaNumber) {
                            shouldDeactivate = true;
                        } else if (itemValue !== null && isNaN(filterSabhaNumber) && filter.filter_value !== null && filter.filter_value !== undefined) {
                            if (String(itemValue) === String(filter.filter_value)) {
                                shouldDeactivate = true;
                            }
                        }
                        break;
                    default:
                        continue;
                }

                if (shouldDeactivate) {
                    // Only need to match one filter to deactivate
                    break;
                }
            }

            if (shouldDeactivate) {
                // Update is_active=false for this video in the videos table
                // Use video_id as the unique identifier
                const videoId = item['Video Id'];
                if (videoId) {
                    try {
                        await client.query(
                            `UPDATE ${VIDEOS_TABLE} SET is_active = false WHERE video_id = $1`,
                            [videoId]
                        );
                        console.log(`Set is_active=false for video_id: ${videoId}`);
                    } catch (updateErr) {
                        console.error(`Failed to update is_active for video_id: ${videoId}`, updateErr);
                    }
                }
            }
        }
        console.log('Filter application complete. Matching videos set to is_active=false.');
    } catch (error) {
        console.error('Error applying filters:', error);
        throw error;
    }
}



// --- ROUTES ---

// --- Root Route ---
app.get('/', async (req, res) => {
    // Check if there's data in the main videos table to decide where to go
    try {
        const result = await pool.query(`SELECT COUNT(*) FROM ${VIDEOS_TABLE}`); // Check videos table
        const totalCount = parseInt(result.rows[0].count);
        if (totalCount > 0) {
            // If data exists, redirect to the main display page
            return res.redirect('/display');
        }
        // If no data, render the initial upload page (index.ejs)
        res.render('index');
    } catch (error) {
        console.error('Error checking database on root request:', error);
        res.status(500).send('Internal Server Error');
    }
});

// --- File Upload Route ---
// --- File Upload Route ---
app.post('/upload', upload.single('excelFile'), async (req, res) => {
    const filePath = req.file ? req.file.path : null; // Get file path early for cleanup

    try {
        const channelId = req.body.channel_id;
        if (!req.file || !channelId) {
            if (filePath) cleanupFile(filePath); // Cleanup if file exists but validation failed
            return res.status(400).send('Missing file or channel selection.');
        }

        console.log(`Starting upload process for channel: ${channelId}`);
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        let data = xlsx.utils.sheet_to_json(worksheet);

        // Basic data filtering (example: remove rows where title is 'Private video')
        data = data.filter(item => item['Video Title'] !== 'Private video');
        console.log(`Parsed ${data.length} rows from Excel (after initial filter).`);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // --- Data Deletion Phase ---
            console.log(`Deleting existing data for channel: ${channelId}`);
            // Delete associated katha_details first due to foreign key
            await client.query(`DELETE FROM ${KATHA_DETAILS_TABLE} WHERE video_id IN (SELECT id FROM ${VIDEOS_TABLE} WHERE channel_id = $1)`, [channelId]);
            // Delete videos for the channel
            await client.query(`DELETE FROM ${VIDEOS_TABLE} WHERE channel_id = $1`, [channelId]);
            console.log('Existing data deletion complete.');

            // --- Data Insertion Phase ---
            console.log('Starting data insertion...');
            let insertedCount = 0;
            for (const row of data) {
                // Extract data from row, providing defaults for missing optional fields
                const videoId = row['Video Id'] || null;
                const videoTitle = row['Video Title'] || 'Untitled';
                const playlistId = row['Playlist Id'] || null;
                const playlistName = row['Playlist Name'] || null;
                const description = row['Description'] || '';
                const privacyStatus = row['Privacy Status'] || 'public';

                // Parse details from description, using 'Type' and 'Category'
                const orator = (description.match(/Orator:\s*([^\n<]+)/) || [])[1]?.trim() || 'NA';
                const sabhaNumber = parseInt((description.match(/Sabha Number:\s*(\d+)/) || [])[1]) || 0;
                const granthName = (description.match(/Grath Name:\s*([^\n<]+)/) || [])[1]?.trim() || 'NA';
                const type = (description.match(/Type:\s*([^\n<]+)/) || [])[1]?.trim() || 'Default'; // Get Type from description
                const category = (description.match(/Category:\s*([^\n<]+)/) || [])[1]?.trim() || 'Uncategorized'; // Get Category from description

                // Determine flags (ensure defaults are false)
                let isMixtv = false;
                let isKathatv = false;
                let isKirtantv = false;
                let isDhuntv = false;
                const typeLower = type.toLowerCase(); // Use type for flag logic
                const categoryLower = category.toLowerCase(); // Use category for flag logic
                // Example logic: Check if multiple terms exist for mix, specific terms otherwise
                const terms = ['katha', 'kirtan', 'dhun'];
                let termCount = 0;
                // Check against both type and category names
                if (typeLower.includes('katha') || categoryLower.includes('katha')) { isKathatv = true; termCount++; }
                if (typeLower.includes('kirtan') || categoryLower.includes('kirtan')) { isKirtantv = true; termCount++; }
                if (typeLower.includes('dhun') || categoryLower.includes('dhun')) { isDhuntv = true; termCount++; }
                if (termCount > 1 || typeLower.includes('mix') || categoryLower.includes('mix')) { isMixtv = true; }

                // Insert/Update Playlist
                if (playlistId) {
                    await client.query(
                        `INSERT INTO ${PLAYLISTS_TABLE} (playlist_id, playlist_name, is_public)
                         VALUES ($1, $2, $3)
                         ON CONFLICT (playlist_id) DO UPDATE SET
                           playlist_name = EXCLUDED.playlist_name,
                           is_public = EXCLUDED.is_public`,
                        [playlistId, playlistName || 'Unknown Playlist', privacyStatus === 'public']
                    );
                }

                // Insert/Update Type (formerly Category)
                const typeRes = await client.query(
                    `INSERT INTO ${TYPES_TABLE} (type_name) VALUES ($1)
                     ON CONFLICT (type_name) DO UPDATE SET type_name = EXCLUDED.type_name
                     RETURNING type_id`,
                    [type]
                );
                const typeId = typeRes.rows[0].type_id;

                // Insert/Update Category (formerly Sub Category)
                // Insert into categories table, referencing the type_id
                const categoryRes = await client.query(
                    `INSERT INTO ${CATEGORIES_TABLE} (category_name, type_id) VALUES ($1, $2)
                     ON CONFLICT (category_name) DO UPDATE SET type_id = EXCLUDED.type_id
                     RETURNING category_id`,
                    [category, typeId] // Use the retrieved typeId
                );
                const categoryId = categoryRes.rows[0].category_id; // This is now the category_id

                // Insert Video (using new foreign key names type_id and category_id)
                const videoInsertRes = await client.query(
                    `INSERT INTO ${VIDEOS_TABLE} (
                        video_id, video_title, playlist_id, playlist_name,
                        type_id, category_id, channel_id, -- Adjusted column names
                        is_mixtv, is_kathatv, is_kirtantv, is_dhuntv,
                        is_active
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                    RETURNING id`,
                    [
                        videoId, videoTitle, playlistId, playlistName,
                        typeId, categoryId, channelId, // Use the retrieved IDs
                        isMixtv, isKathatv, isKirtantv, isDhuntv,
                        true // is_active default true on insert
                    ]
                );
                const videoDbId = videoInsertRes.rows[0].id;

                // Insert into katha_details if applicable
                if (isKathatv || orator !== 'NA' || sabhaNumber !== 0 || granthName !== 'NA') {
                    await client.query(
                        `INSERT INTO ${KATHA_DETAILS_TABLE} (
                            video_id, orator, sabha_number, granth_name,
                            playlist_id, playlist_name
                        ) VALUES ($1, $2, $3, $4, $5, $6)
                        ON CONFLICT (video_id) DO UPDATE SET
                           orator = EXCLUDED.orator,
                           sabha_number = EXCLUDED.sabha_number,
                           granth_name = EXCLUDED.granth_name,
                           playlist_id = EXCLUDED.playlist_id,
                           playlist_name = EXCLUDED.playlist_name`,
                        [videoDbId, orator, sabhaNumber, granthName, playlistId, playlistName]
                    );
                }
                insertedCount++;
            } // End loop through data

            console.log(`Inserted ${insertedCount} video records.`);

            // --- Apply Filters after all data is inserted ---
            await applyFilters(data, client);

            // Refresh derived Dhun data, Kirtan data, and generate Dhun playlist
            console.log('Triggering refresh of Dhun data and playlist...');
            await refreshDhunDashboardData(client);
            
            console.log('Triggering refresh of Kirtan data...');
            await refreshKirtanDashboardData(client); // This will now also call refreshSpecificKirtanTables
            
            await generateKirtanPlaylist(client); // Generate Kirtan playlist after Kirtan data is refreshed
            
            await client.query('COMMIT');
            console.log('Upload process committed successfully.');
            res.redirect('/display?page=1&limit=10');

        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Error during database transaction:', err);
            res.status(500).send('Error during data processing or database operation.');
        } finally {
            client.release();
            if (filePath) cleanupFile(filePath);
            console.log('Database client released and file cleanup attempted.');
        }
    } catch (error) {
        console.error('Error handling file upload or initial processing:', error);
        if (filePath) cleanupFile(filePath);
        res.status(500).send('Upload failed due to server error.');
    }
});

async function getFilteredVideoIds(data, client) {
    // Fetch filters once
    const FILTERS_TABLE = 'video_filters';
    const filterResults = await client.query(`SELECT * FROM ${FILTERS_TABLE}`);
    const filters = filterResults.rows;

    if (filters.length === 0) {
        return new Set(); // No filters, nothing to mark inactive
    }

    // Preprocess filters
    const videoIdSet = new Set();
    const playlistIdSet = new Set();
    const privacyStatusSet = new Set();
    const videoTitleFilters = [];
    const playlistNameFilters = [];

    for (const filter of filters) {
        switch (filter.filter_type) {
            case 'video_id':
                videoIdSet.add(filter.filter_value);
                break;
            case 'playlist_id':
                playlistIdSet.add(filter.filter_value);
                break;
            case 'privacy_status':
                privacyStatusSet.add(filter.filter_value.toLowerCase());
                break;
            case 'video_title':
                videoTitleFilters.push(filter.filter_value.toLowerCase());
                break;
            case 'playlist_name':
                playlistNameFilters.push(filter.filter_value.toLowerCase());
                break;
            default:
                break;
        }
    }

    // Find video IDs that match any filter
    const filteredIds = new Set();
    for (const item of data) {
        if (videoIdSet.has(item['Video Id'])) { filteredIds.add(item['Video Id']); continue; }
        if (playlistIdSet.has(item['Playlist Id'])) { filteredIds.add(item['Video Id']); continue; }
        if (privacyStatusSet.has((item['Privacy Status'] || '').toLowerCase())) { filteredIds.add(item['Video Id']); continue; }
        const itemTitle = (item['Video Title'] || '').toLowerCase();
        if (videoTitleFilters.some(f => itemTitle.includes(f))) { filteredIds.add(item['Video Id']); continue; }
        const itemName = (item['Playlist Name'] || '').toLowerCase();
        if (playlistNameFilters.some(f => itemName.includes(f))) { filteredIds.add(item['Video Id']); continue; }
    }
    return filteredIds;
}

async function getFilteredVideoIds(data, client) {
    // Fetch filters once
    const FILTERS_TABLE = 'video_filters';
    const filterResults = await client.query(`SELECT * FROM ${FILTERS_TABLE}`);
    const filters = filterResults.rows;

    if (filters.length === 0) {
        return new Set(); // No filters, nothing to mark inactive
    }

    // Preprocess filters
    const videoIdSet = new Set();
    const playlistIdSet = new Set();
    const privacyStatusSet = new Set();
    const videoTitleFilters = [];
    const playlistNameFilters = [];

    for (const filter of filters) {
        switch (filter.filter_type) {
            case 'video_id':
                videoIdSet.add(filter.filter_value);
                break;
            case 'playlist_id':
                playlistIdSet.add(filter.filter_value);
                break;
            case 'privacy_status':
                privacyStatusSet.add(filter.filter_value.toLowerCase());
                break;
            case 'video_title':
                videoTitleFilters.push(filter.filter_value.toLowerCase());
                break;
            case 'playlist_name':
                playlistNameFilters.push(filter.filter_value.toLowerCase());
                break;
            default:
                break;
        }
    }

    // Find video IDs that match any filter
    const filteredIds = new Set();
    for (const item of data) {
        if (videoIdSet.has(item['Video Id'])) { filteredIds.add(item['Video Id']); continue; }
        if (playlistIdSet.has(item['Playlist Id'])) { filteredIds.add(item['Video Id']); continue; }
        if (privacyStatusSet.has((item['Privacy Status'] || '').toLowerCase())) { filteredIds.add(item['Video Id']); continue; }
        const itemTitle = (item['Video Title'] || '').toLowerCase();
        if (videoTitleFilters.some(f => itemTitle.includes(f))) { filteredIds.add(item['Video Id']); continue; }
        const itemName = (item['Playlist Name'] || '').toLowerCase();
        if (playlistNameFilters.some(f => itemName.includes(f))) { filteredIds.add(item['Video Id']); continue; }
    }
    return filteredIds;
}

// --- Display Routes ---

// Display Main Video List
// Display Main Video List (only active videos)
app.get('/display', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        let limitParam = req.query.limit || 10;
        let limit = limitParam;
        let offset = 0;

        const client = await pool.connect();
        try {
            const countResult = await client.query(`SELECT COUNT(*) FROM ${VIDEOS_TABLE} WHERE is_active = true`);
            const totalRecords = parseInt(countResult.rows[0].count);
            let totalPages = 1;

            if (limitParam === "all") {
                limit = totalRecords > 0 ? totalRecords : 1;
                totalPages = 1;
                offset = 0;
            } else {
                limit = parseInt(limitParam, 10);
                if (isNaN(limit) || limit <= 0) {
                    limit = 10;
                }
                totalPages = totalRecords > 0 ? Math.ceil(totalRecords / limit) : 1;
                offset = (page > 0 ? page - 1 : 0) * limit;
            }

            // Fetch only active video records with pagination and joins
            const videoQuery = `
                SELECT
                    v.id AS db_id,
                    v.video_id,
                    v.video_title,
                    v.channel_id,
                    t.type_name,
                    c.category_name,
                    v.playlist_id,
                    p.playlist_name,
                    k.orator,
                    k.sabha_number,
                    k.granth_name
                FROM ${VIDEOS_TABLE} v
                LEFT JOIN ${TYPES_TABLE} t ON v.type_id = t.type_id
                LEFT JOIN ${CATEGORIES_TABLE} c ON v.category_id = c.category_id
                LEFT JOIN ${PLAYLISTS_TABLE} p ON v.playlist_id = p.playlist_id
                LEFT JOIN ${KATHA_DETAILS_TABLE} k ON v.id = k.video_id
                WHERE v.is_active = true
                ORDER BY v.id DESC
                LIMIT $1 OFFSET $2;
            `;
            const videosResult = await client.query(videoQuery, [limit, offset]);

            res.render('display', {
                videos: videosResult.rows,
                currentPage: page > 0 ? page : 1,
                totalPages: totalPages,
                limit: limitParam, 
                totalRecords: totalRecords,
                currentRoute: req.path // Add this line
            });
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Error fetching videos for display:', err);
        res.status(500).send('Error retrieving video records.');
    }
});


// --- Edit Routes ---

// Show Edit Form
app.get('/edit/:dbId', async (req, res) => {
    const { dbId } = req.params;
    const parsedDbId = parseInt(dbId, 10);

    if (isNaN(parsedDbId)) {
        return res.status(400).send('Invalid video ID format. Video ID must be an integer.');
    }

     let client;
    try {
        client = await pool.connect();
        const query = `
            SELECT
                v.id AS db_id,
                v.video_id,
                v.video_title,
                v.channel_id,
                t.type_name,     -- Select type name
                c.category_name, -- Select category name
                v.playlist_id,
                p.playlist_name,
                kd.orator,
                kd.sabha_number,
                kd.granth_name
            FROM ${VIDEOS_TABLE} v
            LEFT JOIN ${TYPES_TABLE} t ON v.type_id = t.type_id -- Join types
            LEFT JOIN ${CATEGORIES_TABLE} c ON v.category_id = c.category_id -- Join categories
            LEFT JOIN ${PLAYLISTS_TABLE} p ON v.playlist_id = p.playlist_id
            LEFT JOIN ${KATHA_DETAILS_TABLE} kd ON v.id = kd.video_id
            WHERE v.id = $1
        `; // The query correctly expects an integer for v.id
        const result = await client.query(query, [parsedDbId]);


        if (result.rows.length === 0) {
             client.release();
            return res.status(404).send('Video not found.');
        }

        // For a complete edit form, you'll likely want to fetch lists for dropdowns:
        // const types = await client.query(`SELECT type_id, type_name FROM ${TYPES_TABLE} ORDER BY type_name`);
        // const categories = await client.query(`SELECT category_id, category_name FROM ${CATEGORIES_TABLE} ORDER BY category_name`);
        // const playlists = await client.query(`SELECT playlist_id, playlist_name FROM ${PLAYLISTS_TABLE} ORDER BY playlist_name`);

        res.render('edit', {
            video: result.rows[0],
            currentRoute: req.path // For consistent navbar highlighting
            // types: types.rows,
            // categories: categories.rows,
            // Pass types: types.rows, categories: categories.rows, playlists: playlists.rows etc. if needed
        });

    } catch (error) {
        console.error('Error fetching video for edit:', error);
        res.status(500).send('Error retrieving video data.');
    } finally {
         if (client) client.release();
    }
});

// Handle Edit Form Submission
app.post('/edit/:dbId', async (req, res) => {
    const { dbId } = req.params;
    const parsedDbId = parseInt(dbId, 10);

    if (isNaN(parsedDbId)) {
        return res.status(400).send('Invalid video ID format. Video ID must be an integer.');
    }

    // Extract fields from form body. Adjust these based on your actual edit.ejs form.
    // For this example, we'll only handle video_title.
    // You'll need to expand this to handle other fields like type, category, orator, sabha_number, etc.
    const { video_title /*, type_name, category_name, orator, sabha_number, granth_name */ } = req.body;

    if (!video_title) {
        return res.status(400).send('Video title cannot be empty.');
    }

     let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // Example: Update only video_title in the videos table.
        // You will need to expand this query and potentially update other tables (e.g., katha_details)
        // and handle lookups for type_id and category_id if type_name/category_name are edited.
        const updateQuery = `
            UPDATE ${VIDEOS_TABLE}
            SET video_title = $1
            /*
                , channel_id = $2  -- If channel_id is editable and sent from form
                , type_id = $X     -- Look up type_id based on type_name from form
                , category_id = $Y -- Look up category_id based on category_name from form
                , playlist_id = $Z -- If playlist_id is editable
            */
            WHERE id = $2
        `;
        await client.query(updateQuery, [video_title, parsedDbId]);

        // Example: If katha details (orator, sabha_number, granth_name) are edited, update katha_details table.
        // const { orator, sabha_number, granth_name } = req.body;
        // const updateKathaQuery = `UPDATE ${KATHA_DETAILS_TABLE} SET ... WHERE video_id = $1`;
        // await client.query(updateKathaQuery, [parsedDbId, orator, sabha_number, granth_name]);

        // IMPORTANT: After editing, you might need to refresh the Dhun data
        // if the changes affect Dhun classification (e.g., type/category change)
        console.log('Video updated, triggering Dhun data refresh...');
        // Use a transaction if updating multiple tables and refreshing
        // await client.query('BEGIN'); // Already in a transaction
        await refreshDhunDashboardData(client);
        await refreshKirtanDashboardData(client); // Also refresh Kirtan data if relevant
        await generateKirtanPlaylist(client); // And Kirtan playlist
        await client.query('COMMIT'); // Commit the main transaction


        res.redirect('/display'); // Redirect back to the main display page

    } catch (error) {
        if(client) await client.query('ROLLBACK');
        console.error('Error updating video:', error);
        res.status(500).send('Error updating video.');
    } finally {
        if (client) client.release();
    }
});


// --- Dhun Dashboard Routes ---

// Display Dhun Dashboard
app.get('/dhun-dashboard', async (req, res) => {
     let client;
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 10;
        client = await pool.connect();

        // Get total count for pagination
        const countQuery = `SELECT COUNT(*) FROM ${DHUN_DATA_TABLE}`;
        const countResult = await client.query(countQuery);
        const totalRecords = parseInt(countResult.rows[0].count);
        const totalPages = totalRecords > 0 ? Math.ceil(totalRecords / limit) : 1;
        const offset = (page > 0 ? page - 1 : 0) * limit;

        // Fetch data for the current page, including playlist info, type name, and category name (updated selected columns)
        const query = `
            SELECT
                video_db_id, video_id, video_title, channel_id,
                type_name, category_name, playlist_id, playlist_name -- Adjusted column names
            FROM ${DHUN_DATA_TABLE}
            ORDER BY video_title ASC
            LIMIT $1 OFFSET $2;
        `;
        const result = await client.query(query, [limit, offset]);


        res.render('dhun-dashboard', {
            videos: result.rows,
            currentPage: page > 0 ? page : 1,
            totalPages: totalPages,
            exportUrl: '/dhun-dashboard/export',
            currentRoute: req.path // This is the key line!
        });

    } catch (err) {
        console.error('Error loading Dhun Dashboard:', err);
        res.status(500).send('Failed to load Dhun Dashboard');
    } finally {
        if (client) client.release();
    }
});

// Export Dhun Dashboard Data
app.get('/dhun-dashboard/export', (req, res) => {
    const query = `
        SELECT video_db_id, video_id, video_title, channel_id, type_name, -- Adjusted column names
               category_name, playlist_id, playlist_name
        FROM ${DHUN_DATA_TABLE} ORDER BY video_title ASC`;
    exportToExcel(res, query, 'Dhun_Dashboard_Data');
});

// --- Kirtan Dashboard Routes ---

// Display Kirtan Dashboard
app.get('/kirtan-dashboard', async (req, res) => {
    let client;
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 10; // Or make this configurable like in /display
        client = await pool.connect();

        const countQuery = `SELECT COUNT(*) FROM ${KIRTAN_DATA_TABLE}`;
        const countResult = await client.query(countQuery);
        const totalRecords = parseInt(countResult.rows[0].count);
        const totalPages = totalRecords > 0 ? Math.ceil(totalRecords / limit) : 1;
        const offset = (page > 0 ? page - 1 : 0) * limit;

        const query = `
            SELECT
                video_db_id, video_id, video_title, channel_id,
                type_name, category_name, playlist_id, playlist_name
            FROM ${KIRTAN_DATA_TABLE}
            ORDER BY video_title ASC
            LIMIT $1 OFFSET $2;
        `;
        const result = await client.query(query, [limit, offset]);

        res.render('kirtan-dashboard', { // You'll need to create kirtan-dashboard.ejs
            videos: result.rows,
            currentPage: page > 0 ? page : 1,
            totalPages: totalPages,
            exportUrl: '/kirtan-dashboard/export',
            currentRoute: req.path
        });
    } catch (err) {
        console.error('Error loading Kirtan Dashboard:', err);
        res.status(500).send('Failed to load Kirtan Dashboard');
    } finally {
        if (client) client.release();
    }
});

// Export Kirtan Dashboard Data
app.get('/kirtan-dashboard/export', (req, res) => {
    const query = `
        SELECT video_db_id, video_id, video_title, channel_id, type_name,
               category_name, playlist_id, playlist_name
        FROM ${KIRTAN_DATA_TABLE} ORDER BY video_title ASC`;
    exportToExcel(res, query, 'Kirtan_Dashboard_Data');
});

// --- Specific Dhun Table Routes (Streamed, Lyrical, Jukebox) ---

// Generic function to handle display logic for specific dhun tables
async function displaySpecificDhunTable(req, res, tableName, viewName, exportPath) {
     let client;
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 10;
        client = await pool.connect();

        const countResult = await client.query(`SELECT COUNT(*) FROM ${tableName}`);
        const totalRecords = parseInt(countResult.rows[0].count);
        const totalPages = totalRecords > 0 ? Math.ceil(totalRecords / limit) : 1;
        const offset = (page > 0 ? page - 1 : 0) * limit;

        // Select all columns, which now include playlist info, type name, and category name
        const result = await client.query(`SELECT * FROM ${tableName} ORDER BY id LIMIT $1 OFFSET $2`, [limit, offset]);


        res.render(viewName, {
            videos: result.rows,
            currentPage: page > 0 ? page : 1,
            totalPages: totalPages,
            exportUrl: exportPath
        });
    } catch (error) {
        console.error(`Error loading ${tableName} table:`, error);
        res.status(500).send(`Failed to load ${tableName} data.`);
    } finally {
         if (client) client.release();
    }
}

// Export Main Display Data
app.get('/export', (req, res) => {
    const query = `
        SELECT
            v.id AS db_id,
            v.video_id,
            v.video_title,
            v.channel_id,
            t.type_name,     -- Select type name
            c.category_name, -- Select category name
            v.playlist_id,
            p.playlist_name,
            k.orator,
            k.sabha_number,
            k.granth_name
        FROM ${VIDEOS_TABLE} v
        LEFT JOIN ${TYPES_TABLE} t ON v.type_id = t.type_id -- Join types
        LEFT JOIN ${CATEGORIES_TABLE} c ON v.category_id = c.category_id -- Join categories
        LEFT JOIN ${PLAYLISTS_TABLE} p ON v.playlist_id = p.playlist_id
        LEFT JOIN ${KATHA_DETAILS_TABLE} k ON v.id = k.video_id
        ORDER BY v.id DESC;
    `;
    exportToExcel(res, query, 'Main_Display_Data');
});

// Route to display streamed dhun table
app.get('/streamed-dhun', (req, res) => {
    displaySpecificDhunTable(req, res, STREAMED_DHUN_TABLE, 'streamed-dhun', '/streamed-dhun/export');
});

// Route to display lyrical video dhun table
app.get('/lyrical-video-dhun', (req, res) => {
    displaySpecificDhunTable(req, res, LYRICAL_DHUN_TABLE, 'lyrical-video-dhun', '/lyrical-video-dhun/export');
});

// Route to display dhun jukebox table
app.get('/dhun-jukebox', (req, res) => {
    displaySpecificDhunTable(req, res, DHUN_JUKEBOX_TABLE, 'dhun-jukebox', '/dhun-jukebox/export');
});

// --- Specific Dhun Table Export Routes ---

// Export Streamed Dhun data
app.get('/streamed-dhun/export', (req, res) => {
    const query = `SELECT * FROM ${STREAMED_DHUN_TABLE} ORDER BY id`;
    exportToExcel(res, query, 'Streamed_Dhun_Data');
});

// Export Lyrical Video Dhun data
app.get('/lyrical-video-dhun/export', (req, res) => {
    const query = `SELECT * FROM ${LYRICAL_DHUN_TABLE} ORDER BY id`;
    exportToExcel(res, query, 'Lyrical_Video_Dhun_Data');
});

// Export Dhun Jukebox data
app.get('/dhun-jukebox/export', (req, res) => {
    const query = `SELECT * FROM ${DHUN_JUKEBOX_TABLE} ORDER BY id`;
    exportToExcel(res, query, 'Dhun_Jukebox_Data');
});


// --- Dhun Playlist Routes ---
// Display Generated Dhun Playlist
app.get('/dhun-playlist', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        let requestedLimit = req.query.limit; // Can be a number or 'all'
        let limit = parseInt(requestedLimit) || 10; // Default to 10 if not a valid number

        const client = await pool.connect();
        try {
            const countQuery = `SELECT COUNT(*) FROM ${DHUN_PLAYLIST_TABLE}`;
            const countResult = await client.query(countQuery);
            const totalRecords = parseInt(countResult.rows[0].count);

            if (requestedLimit === 'all') {
                limit = totalRecords > 0 ? totalRecords : 1; // Show all records
            }

            const totalPages = totalRecords > 0 ? Math.ceil(totalRecords / limit) : 1;
            const offset = (page > 0 ? page - 1 : 0) * limit;

            const query = `
                SELECT playlist_order, video_id, video_title, channel_id, type_name, category_name, playlist_id, playlist_name
                FROM ${DHUN_PLAYLIST_TABLE}
                ORDER BY playlist_order ASC
                LIMIT $1 OFFSET $2;
            `;
            const result = await client.query(query, [limit, offset]);

            res.render('dhun-playlist', {
                playlist: result.rows,
                exportUrl: '/dhun-playlist/export',
                currentRoute: req.path,
                currentPage: page > 0 ? page : 1,
                totalPages: totalPages,
                limit: limit, // Pass the actual limit used (could be totalRecords if 'all')
                totalRecords: totalRecords // Pass totalRecords for the 'all' option logic
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error loading Dhun Playlist:', error);
        // Check if the table exists, maybe it wasn't generated yet
        if (error.code === '42P01') { // '42P01' is PostgreSQL code for undefined_table
             res.status(404).send('Dhun playlist has not been generated yet. Please upload data first.');
        } else {
            res.status(500).send('Failed to load Dhun Playlist');
        }
    }
});

// Export Dhun Playlist Data
app.get('/dhun-playlist/export', (req, res) => {
    const query = `
        SELECT video_db_id, video_id, video_title, channel_id, type_name, -- Adjusted column names
               category_name, playlist_id, playlist_name, playlist_order
        FROM ${DHUN_PLAYLIST_TABLE}
        ORDER BY playlist_order ASC
    `;
    exportToExcel(res, query, 'Dhun_Playlist');
});

// --- Kirtan Playlist Routes ---
app.get('/kirtan-playlist', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        let requestedLimit = req.query.limit;
        let limit = parseInt(requestedLimit) || 10;

        const client = await pool.connect();
        try {
            const countQuery = `SELECT COUNT(*) FROM ${KIRTAN_PLAYLIST_TABLE}`;
            const countResult = await client.query(countQuery);
            const totalRecords = parseInt(countResult.rows[0].count);

            if (requestedLimit === 'all') {
                limit = totalRecords > 0 ? totalRecords : 1;
            }

            const totalPages = totalRecords > 0 ? Math.ceil(totalRecords / limit) : 1;
            const offset = (page > 0 ? page - 1 : 0) * limit;

            const query = `
                SELECT playlist_order, video_id, video_title, channel_id, type_name, category_name, playlist_id, playlist_name
                FROM ${KIRTAN_PLAYLIST_TABLE}
                ORDER BY playlist_order ASC
                LIMIT $1 OFFSET $2;
            `;
            const result = await client.query(query, [limit, offset]);

            res.render('kirtan-playlist', { // Ensure you create kirtan-playlist.ejs
                playlist: result.rows,
                exportUrl: '/kirtan-playlist/export',
                currentRoute: req.path,
                currentPage: page > 0 ? page : 1,
                totalPages: totalPages,
                limit: limit, 
                totalRecords: totalRecords
            });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error loading Kirtan Playlist:', error);
        if (error.code === '42P01') { 
             res.status(404).send('Kirtan playlist has not been generated yet. Please upload data first.');
        } else {
            res.status(500).send('Failed to load Kirtan Playlist');
        }
    }
});

// Export Kirtan Playlist Data
app.get('/kirtan-playlist/export', (req, res) => {
    const query = `
        SELECT video_db_id, video_id, video_title, channel_id, type_name,
               category_name, playlist_id, playlist_name, playlist_order
        FROM ${KIRTAN_PLAYLIST_TABLE}
        ORDER BY playlist_order ASC
    `;
    exportToExcel(res, query, 'Kirtan_Playlist');
});

// --- Video Filter Management Routes ---

// Display Video Filters Page
app.get('/video-filters', async (req, res) => {
     let client;
    try {
        client = await pool.connect();
        const result = await client.query(`SELECT * FROM ${VIDEO_FILTERS_TABLE} ORDER BY timestamp DESC`);


        // List of allowed filter types for the form dropdown (updated to include 'Type' and 'Category')
        const filterTypes = [
            'video_id', 'video_title', 'playlist_id', 'playlist_name', 'privacy_status',
            'Type', 'Category', 'Orator', 'Sabha Number/Track Number'
        ];

        res.render('video-filters', {
            filters: result.rows,
            filterTypes: filterTypes,
            exportUrl: '/video-filters/export',
            importUrl: '/video-filters/import',
            currentRoute: req.path // Add this line
        });
    } catch (error) {
        console.error('Error loading video filters:', error);
        res.status(500).send('Failed to load video filters.');
    } finally {
        if (client) client.release();
    }
});

// Add a New Filter
app.post('/video-filters/add', async (req, res) => {
     let client;
    try {
        const { filter_type, filter_value, matched_video_title } = req.body;

        // Basic validation
        if (!filter_type || !filter_value) {
            return res.status(400).send('Filter type and filter value are required.');
        }

        client = await pool.connect();
        await client.query(
            `INSERT INTO ${VIDEO_FILTERS_TABLE} (filter_type, filter_value, matched_video_title)
             VALUES ($1, $2, $3)`,
            [filter_type, filter_value, matched_video_title || null]
        );

        res.redirect('/video-filters');
    } catch (error) {
        console.error('Error adding video filter:', error);
        res.status(500).send('Failed to add video filter.');
    } finally {
         if (client) client.release();
    }
});

// Delete a Filter
app.post('/video-filters/delete/:filter_id', async (req, res) => {
     let client;
    try {
        const { filter_id } = req.params;
        client = await pool.connect();
        const result = await client.query(`DELETE FROM ${VIDEO_FILTERS_TABLE} WHERE filter_id = $1`, [filter_id]);


        if (result.rowCount === 0) {
             console.log(`Attempted to delete non-existent filter with ID: ${filter_id}`);
        }

        res.redirect('/video-filters');
    } catch (error) {
        console.error('Error deleting video filter:', error);
        res.status(500).send('Failed to delete video filter.');
    } finally {
         if (client) client.release();
    }
});

// Export Video Filters
app.get('/video-filters/export', (req, res) => {
    const query = `SELECT filter_id, filter_type, filter_value, matched_video_title, timestamp FROM ${VIDEO_FILTERS_TABLE} ORDER BY timestamp DESC`;
    exportToExcel(res, query, 'Video_Filters');
});

// Import Video Filters
app.post('/video-filters/import', upload.single('excelFile'), async (req, res) => {
    const filePath = req.file ? req.file.path : null;
    if (!filePath) {
        return res.status(400).send('Please upload an Excel file.');
    }

    let client;
    try {
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(worksheet);

        client = await pool.connect();
        try {
            await client.query('BEGIN');
            let importCount = 0;
            for (const row of data) {
                const filter_type = row.filter_type;
                const filter_value = row.filter_value;
                const matched_video_title = row.matched_video_title || null;

                if (filter_type && filter_value) {
                    await client.query(
                        `INSERT INTO ${VIDEO_FILTERS_TABLE} (filter_type, filter_value, matched_video_title)
                         VALUES ($1, $2, $3)`,
                        [filter_type, filter_value, matched_video_title]
                    );
                     importCount++;
                } else {
                    console.warn('Skipping row in filter import due to missing type or value:', row);
                }
            }
            await client.query('COMMIT');
            console.log(`Successfully imported ${importCount} filters.`);
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error importing video filters during transaction:', error);
            return res.status(500).send('Error importing video filters.');
        } finally {
            client.release();
        }

        res.redirect('/video-filters');
    } catch (error) {
        console.error('Error handling filter import file processing:', error);
        if (client) client.release();
        res.status(500).send('Internal server error during file processing.');
    } finally {
         if (filePath) cleanupFile(filePath);
    }
});

// --- Server Start ---
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
/**
 * POST /video-filters/apply
 * Applies current filters to the videos table by setting is_active = false for matching videos.
 */
app.post('/video-filters/apply', async (req, res) => {
    const client = await pool.connect();
    try {
        // Fetch all filters
        const filterResults = await client.query(`SELECT * FROM ${VIDEO_FILTERS_TABLE}`);
        const filters = filterResults.rows;
        if (filters.length === 0) {
            client.release();
            return res.redirect('/video-filters');
        }

        // Fetch all videos
        const videoResults = await client.query(`
            SELECT v.id, v.video_id, v.video_title, v.playlist_id, v.channel_id, v.is_active, v.category_id, v.sub_category_id,
                   p.playlist_name
            FROM videos v
            LEFT JOIN playlists p ON v.playlist_id = p.playlist_id
        `);
        const videos = videoResults.rows;

        // Preprocess filters for efficient matching
        const videoIdSet = new Set();
        const playlistIdSet = new Set();
        const privacyStatusSet = new Set();
        const videoTitleFilters = [];
        const playlistNameFilters = [];

        for (const filter of filters) {
            switch (filter.filter_type) {
                case 'video_id':
                    videoIdSet.add(filter.filter_value);
                    break;
                case 'playlist_id':
                    playlistIdSet.add(filter.filter_value);
                    break;
                case 'privacy_status':
                    privacyStatusSet.add(filter.filter_value.toLowerCase());
                    break;
                case 'video_title':
                    videoTitleFilters.push(filter.filter_value.toLowerCase());
                    break;
                case 'playlist_name':
                    playlistNameFilters.push(filter.filter_value.toLowerCase());
                    break;
                default:
                    break;
            }
        }

        // Find video IDs that match any filter
        const filteredDbIds = [];
        const allDbIds = [];
        for (const video of videos) {
            allDbIds.push(video.id);
            let exclude = false;
            if (videoIdSet.has(video.video_id)) { exclude = true; }
            if (playlistIdSet.has(video.playlist_id)) { exclude = true; }
            // privacy_status is not present in your schema, so skip
            const itemTitle = (video.video_title || '').toLowerCase();
            if (videoTitleFilters.some(f => itemTitle.includes(f))) { exclude = true; }
            const itemName = (video.playlist_name || '').toLowerCase();
            if (playlistNameFilters.some(f => itemName.includes(f))) { exclude = true; }
            if (exclude) {
                filteredDbIds.push(video.id);
            }
        }

        // Compute non-filtered IDs
        const filteredSet = new Set(filteredDbIds);
        const nonFilteredDbIds = allDbIds.filter(id => !filteredSet.has(id));

        await client.query('BEGIN');
        // Set is_active = false for filtered videos
        if (filteredDbIds.length > 0) {
            await client.query(
                `UPDATE videos SET is_active = false WHERE id = ANY($1::int[])`,
                [filteredDbIds]
            );
        }
        // Set is_active = true for non-filtered videos
        if (nonFilteredDbIds.length > 0) {
            await client.query(
                `UPDATE videos SET is_active = true WHERE id = ANY($1::int[])`,
                [nonFilteredDbIds]
            );
        }
        await client.query('COMMIT');
        client.release();
        res.redirect('/video-filters?applied=1');
    } catch (error) {
        await client.query('ROLLBACK');
        client.release();
        console.error('Error applying filters to videos:', error);
        res.status(500).send('Failed to apply filters.');
    }
});

/**
 * POST /video-filters/apply
 * Applies current filters to the videos table by setting is_active = false for matching videos.
 */
app.post('/video-filters/apply', async (req, res) => {
    const client = await pool.connect();
    try {
        // Fetch all filters
        const filterResults = await client.query(`SELECT * FROM ${VIDEO_FILTERS_TABLE}`);
        const filters = filterResults.rows;
        if (filters.length === 0) {
            client.release();
            return res.redirect('/video-filters');
        }

        // Fetch all videos
        const videoResults = await client.query(`
            SELECT v.id, v.video_id, v.video_title, v.playlist_id, v.channel_id, v.is_active, v.category_id, v.sub_category_id,
                   p.playlist_name
            FROM videos v
            LEFT JOIN playlists p ON v.playlist_id = p.playlist_id
        `);
        const videos = videoResults.rows;

        // Preprocess filters for efficient matching
        const videoIdSet = new Set();
        const playlistIdSet = new Set();
        const privacyStatusSet = new Set();
        const videoTitleFilters = [];
        const playlistNameFilters = [];

        for (const filter of filters) {
            switch (filter.filter_type) {
                case 'video_id':
                    videoIdSet.add(filter.filter_value);
                    break;
                case 'playlist_id':
                    playlistIdSet.add(filter.filter_value);
                    break;
                case 'privacy_status':
                    privacyStatusSet.add(filter.filter_value.toLowerCase());
                    break;
                case 'video_title':
                    videoTitleFilters.push(filter.filter_value.toLowerCase());
                    break;
                case 'playlist_name':
                    playlistNameFilters.push(filter.filter_value.toLowerCase());
                    break;
                default:
                    break;
            }
        }

        // Find video IDs that match any filter
        const filteredDbIds = [];
        const allDbIds = [];
        for (const video of videos) {
            allDbIds.push(video.id);
            let exclude = false;
            if (videoIdSet.has(video.video_id)) { exclude = true; }
            if (playlistIdSet.has(video.playlist_id)) { exclude = true; }
            // privacy_status is not present in your schema, so skip
            const itemTitle = (video.video_title || '').toLowerCase();
            if (videoTitleFilters.some(f => itemTitle.includes(f))) { exclude = true; }
            const itemName = (video.playlist_name || '').toLowerCase();
            if (playlistNameFilters.some(f => itemName.includes(f))) { exclude = true; }
            if (exclude) {
                filteredDbIds.push(video.id);
            }
        }

        // Compute non-filtered IDs
        const filteredSet = new Set(filteredDbIds);
        const nonFilteredDbIds = allDbIds.filter(id => !filteredSet.has(id));

        await client.query('BEGIN');
        // Set is_active = false for filtered videos
        if (filteredDbIds.length > 0) {
            await client.query(
                `UPDATE videos SET is_active = false WHERE id = ANY($1::int[])`,
                [filteredDbIds]
            );
        }
        // Set is_active = true for non-filtered videos
        if (nonFilteredDbIds.length > 0) {
            await client.query(
                `UPDATE videos SET is_active = true WHERE id = ANY($1::int[])`,
                [nonFilteredDbIds]
            );
        }
        await client.query('COMMIT');
        client.release();
        res.redirect('/video-filters?applied=1');
    } catch (error) {
        await client.query('ROLLBACK');
        client.release();
        console.error('Error applying filters to videos:', error);
        res.status(500).send('Failed to apply filters.');
    }
});

