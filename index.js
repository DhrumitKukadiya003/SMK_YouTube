const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const { Pool } = require('pg');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const port = 3000;

// Configure PostgreSQL connection
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'youtube_db',
    password: 'postgres', // Change to your PostgreSQL password
    port: 5432,
    //port: 5432, // Removed duplicate port definition
});

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Set up EJS as the view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Define the new table names
const DHUN_DATA_TABLE = 'dhun_dashboard_data';
const DHUN_PLAYLIST_TABLE = 'dhun_playlist';
const STREAMED_DHUN_TABLE = 'streamed_dhun_table';
const LYRICAL_DHUN_TABLE = 'lyrical_video_dhun_table';
const DHUN_JUKEBOX_TABLE = 'dhun_jukebox_table';
const VIDEO_FILTERS_TABLE = 'video_filters'; // Define the video filters table name

// Function to refresh specific dhun tables
async function refreshSpecificDhunTables(client) {
    try {
        // Refresh streamed_dhun_table
        await client.query(`DROP TABLE IF EXISTS ${STREAMED_DHUN_TABLE}`);
        await client.query(`
                                        CREATE TABLE ${STREAMED_DHUN_TABLE} AS
                                        SELECT * FROM ${DHUN_DATA_TABLE}
                                        WHERE LOWER(category_name) LIKE '%streamed dhun%' OR LOWER(sub_category_name) LIKE '%streamed dhun%'
                                    `);
        console.log(`${STREAMED_DHUN_TABLE} refreshed.`);

        // Refresh lyrical_video_dhun_table
        await client.query(`DROP TABLE IF EXISTS ${LYRICAL_DHUN_TABLE}`);
        await client.query(`
                                        CREATE TABLE ${LYRICAL_DHUN_TABLE} AS
                                        SELECT * FROM ${DHUN_DATA_TABLE}
                                        WHERE LOWER(category_name) LIKE '%lyrical video%' OR LOWER(sub_category_name) LIKE '%lyrical video%'
                                    `);
        console.log(`${LYRICAL_DHUN_TABLE} refreshed.`);

        // Refresh dhun_jukebox_table
        await client.query(`DROP TABLE IF EXISTS ${DHUN_JUKEBOX_TABLE}`);
        await client.query(`
                                        CREATE TABLE ${DHUN_JUKEBOX_TABLE} AS
                                        SELECT * FROM ${DHUN_DATA_TABLE}
                                        WHERE LOWER(category_name) LIKE '%dhun jukebox%' OR LOWER(sub_category_name) LIKE '%dhun jukebox%'
                                    `);
        console.log(`${DHUN_JUKEBOX_TABLE} refreshed.`);

    } catch (error) {
        console.error('Error refreshing specific dhun tables:', error);
        throw error;
    }
}

// Function to refresh the dhun dashboard data
async function refreshDhunDashboardData(client) {
    try {
        // Clear the existing data in the table
        await client.query(`DELETE FROM ${DHUN_DATA_TABLE}`);

        // Re-populate the table with the latest data from the videos table
        const query = `
                                        INSERT INTO ${DHUN_DATA_TABLE} (
                                            video_id, video_title, channel_id, category_name, sub_category_name
                                        )
                                        SELECT
                                            v.video_id,
                                            v.video_title,
                                            v.channel_id,
                                            c.category_name AS category_name,
                                            sc.sub_category_name AS sub_category_name
                                        FROM videos v
                                        LEFT JOIN categories c ON v.category_id = c.category_id
                                        LEFT JOIN sub_categories sc ON v.sub_category_id = sc.sub_category_id
                                        LEFT JOIN katha_details k ON v.id = k.video_id
                                        WHERE (LOWER(c.category_name) LIKE '%dhun%' OR LOWER(sc.sub_category_name) LIKE '%dhun%' OR c.category_name = 'Dhun Jukebox' OR
                                                v.id IN (SELECT vd.id FROM videos vd INNER JOIN katha_details kd ON vd.id = kd.video_id WHERE LOWER(kd.granth_name) LIKE '%dhun%'))
                                          AND LOWER(c.category_name) NOT LIKE '%kirtan/instrumental/dhun%'
                                          AND LOWER(sc.sub_category_name) NOT LIKE '%kirtan/instrumental/dhun%'
                                        ORDER BY v.video_title ASC;
                                    `;
        await client.query(query);

        console.log('Dhun dashboard data refreshed successfully.');


        // Refresh the specific dhun tables
        await refreshSpecificDhunTables(client);
        // Now generate the playlist
        await generateDhunPlaylist(client);

    } catch (error) {
        console.error('Error refreshing dhun dashboard data:', error);
        throw error;
    }
}


// Check for existing data on server start
app.get('/', async (req, res) => {
    try {
        const result = await pool.query(`SELECT COUNT(*) FROM ${DHUN_DATA_TABLE}`);
        const totalCount = parseInt(result.rows[0].count);
        if (totalCount > 0) {
            return res.redirect('/display');
        }
        res.render('index');
    } catch (error) {
        console.error('Error checking database:', error);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/upload', (req, res) => {
    res.render('index');
});

/**
 * Applies filters from the database to the uploaded data.
 * @param {Array} data - The video data extracted from the Excel file.
 * @param {pg.Client} client - The PostgreSQL client.
 * @returns {Promise<Array>} - The filtered data.
 */
async function applyFilters(data, client) {
    try {
        const filterResults = await client.query(`SELECT * FROM ${VIDEtheiO_FILTERS_TABLE}`);
        const filters = filterResults.rows;

        if (filters.length === 0) {
            return data; // No filters, return original data (no exclusion)
        }

        let filteredData = []; // Array to hold videos that *pass* the filters (i.e., are NOT excluded)

        for (const item of data) {
            let exclude = false; // Start by assuming we *don't* exclude this item

            for (const filter of filters) {
                const filterType = filter.filter_type;
                const filterValue = filter.filter_value;

                switch (filterType) {
                    case 'video_id':
                        if (item['Video Id'] === filterValue) {
                            exclude = true; // Exclude this item
                        }
                        break;
                    case 'video_title':
                        const itemTitle = item['Video Title']?.toLowerCase() || '';
                        const filterTitle = filterValue.toLowerCase();
                        if (itemTitle.includes(filterTitle)) {
                            exclude = true; // Exclude this item
                        }
                        break;
                    case 'playlist_id':
                        if (item['Playlist Id'] === filterValue) {
                            exclude = true;
                        }
                        break;
                    case 'playlist_name':
                        const itemName = item['Playlist Name']?.toLowerCase() || '';
                        const filterName = filterValue.toLowerCase();
                        if (itemName.includes(filterName)) {
                            exclude = true;
                        }
                        break;
                    case 'privacy_status':
                        const itemStatus = item['Privacy Status']?.toLowerCase() || '';
                        const filterStatus = filterValue.toLowerCase();
                        if (itemStatus === filterStatus) {
                            exclude = true;
                        }
                        break;
                    default:
                        // Ignore unknown filter types
                        break;
                }
                if (exclude) {
                    break; // No need to check other filters for this item
                }
            }
            if (!exclude) {
                filteredData.push(item); // Include the item if it wasn't excluded
            }
        }
        return filteredData;
    } catch (error) {
        console.error('Error applying filters:', error);
        throw error;
    }
}


app.post('/upload', upload.single('excelFile'), async (req, res) => {
    try {
        const channelId = req.body.channel_id;
        if (!req.file || !channelId) {
            return res.status(400).send('Missing file or channel selection.');
        }

        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        let data = xlsx.utils.sheet_to_json(worksheet);
        data = data.filter(item => item['Video Title'] !== 'Private video');

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Get video IDs that should be inactive
            const filteredIds = await getFilteredVideoIds(data, client);

            // Delete old data for this channel
            await client.query(`DELETE FROM katha_details WHERE video_id IN (SELECT id FROM videos WHERE channel_id = $1)`, [channelId]);
            await client.query(`DELETE FROM videos WHERE channel_id = $1`, [channelId]);
            await client.query(`DELETE FROM playlists WHERE playlist_id IN (SELECT DISTINCT playlist_id FROM videos WHERE channel_id = $1)`, [channelId]);
            await client.query(`DELETE FROM sub_categories WHERE sub_category_id NOT IN (SELECT DISTINCT sub_category_id FROM videos)`);
            await client.query(`DELETE FROM categories WHERE category_id NOT IN (SELECT DISTINCT category_id FROM videos)`);

            for (const row of data) {
                const description = row.Description || '';
                const orator = (description.match(/Orator: ([^\n<]+)/) || [])[1]?.trim() || '';
                const sabhaNumber = parseInt((description.match(/Sabha Number: (\d+)/) || [])[1]) || 0;
                const granthName = (description.match(/Granth Name: ([^\n<]+)/) || [])[1]?.trim() || 'NA';

                const category = (description.match(/Category: ([^\n<]+)/) || [])[1]?.trim() || '';
                let subCategory = (description.match(/Sub Category: ([^\n<]+)/) || [])[1]?.trim() || '';
                if (!subCategory) {
                    subCategory = (description.match(/Type: ([^\n<]+)/) || [])[1]?.trim() || '';
                }

                // Determine flags based on category or description
                let isMixtv = false;
                let isKathatv = false;
                let isKirtantv = false;
                let isDhuntv = false;

                const terms = ['mix', 'katha', 'kirtan', 'dhun'];
                const categoryLower = category.toLowerCase();
                if (terms.some(term => categoryLower.includes(term))) isMixtv = true;
                if (categoryLower.includes('katha')) isKathatv = true;
                if (categoryLower.includes('kirtan')) isKirtantv = true;
                if (categoryLower.includes('dhun')) isDhuntv = true;

                // Avoid playlist duplication
                await client.query(`
                    INSERT INTO playlists (playlist_id, playlist_name, is_public)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (playlist_id) DO UPDATE SET playlist_name = EXCLUDED.playlist_name
                `, [row['Playlist Id'], row['Playlist Name'], row['Privacy Status'] === 'public']);

                const categoryRes = await client.query(`
                    INSERT INTO categories (category_name)
                    VALUES ($1)
                    ON CONFLICT (category_name) DO UPDATE SET category_name = EXCLUDED.category_name
                    RETURNING category_id
                `, [category]);
                const categoryId = categoryRes.rows[0].category_id;

                const subCatRes = await client.query(`
                    INSERT INTO sub_categories (sub_category_name, category_id)
                    VALUES ($1, $2)
                    ON CONFLICT (sub_category_name) DO UPDATE SET sub_category_name = EXCLUDED.sub_category_name
                    RETURNING sub_category_id
                `, [subCategory, categoryId]);
                const subCategoryId = subCatRes.rows[0].sub_category_id;

                // Set is_active = false if filtered, true otherwise
                const isActive = !filteredIds.has(row['Video Id']);

                // Insert video with flags and is_active
                const videoInsertRes = await client.query(`
                    INSERT INTO videos (
                        video_id, video_title, playlist_id, category_id, sub_category_id, channel_id,
                        is_mixtv, is_kathatv, is_kirtantv, is_dhuntv, is_active
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                    RETURNING id
                `, [
                    row['Video Id'], row['Video Title'], row['Playlist Id'], categoryId, subCategoryId, channelId,
                    isMixtv, isKathatv, isKirtantv, isDhuntv, isActive
                ]);
                const videoDbId = videoInsertRes.rows[0].id;

                // Insert into katha_details if available
                if (orator || sabhaNumber || granthName) {
                    await client.query(`
                        INSERT INTO katha_details (video_id, orator, sabha_number, granth_name)
                        VALUES ($1, $2, $3, $4)
                    `, [videoDbId, orator, sabhaNumber, granthName]);
                }
            }

            // Refresh the dhun dashboard data immediately after upload
            await refreshDhunDashboardData(client);
            await client.query('COMMIT');

            console.log('Data uploaded successfully. Dhun dashboard data and related tables updated.');
            res.redirect('/display?page=1&limit=10');
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Upload error:', err);
            res.status(500).send('Error during upload.');
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Upload handler failed:', error);
        res.status(500).send('Upload failed.');
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


// Display data from database with pagination
app.get('/display', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        let limit = req.query.limit || 10;                // Default limit is 10

        const client = await pool.connect();

        // Fetch total count of videos
        const countResult = await client.query('SELECT COUNT(*) FROM videos');
        const totalRecords = parseInt(countResult.rows[0].count);

        let totalPages = Math.ceil(totalRecords / limit);

        // If 'all' is selected, fetch all records and disable pagination
        if (limit === "all") {
            limit = totalRecords;
            totalPages = 1;
        } else {
            limit = parseInt(limit, 10); // Ensure limit is parsed as an integer (base 10)
        }

        const offset = (page - 1) * limit;

        // Fetch video records with pagination (unless 'all' is selected)
        const videoQuery = `
                                        SELECT
                                            v.video_id,
                                            v.video_title,
                                            v.channel_id,
                                            c.category_name AS category_name,
                                            sc.sub_category_name AS sub_category_name,
                                            k.orator,
                                            k.sabha_number,
                                            v.id AS db_id
                                        FROM videos v
                                        LEFT JOIN categories c ON v.category_id = c.category_id
                                        LEFT JOIN sub_categories sc ON v.sub_category_id = sc.sub_category_id
                                        LEFT JOIN katha_details k ON v.id = k.video_id
                                        ORDER BY v.video_id
                                        LIMIT $1 OFFSET $2;
                                    `;

        const videos = await client.query(videoQuery, [limit, offset]);
        client.release();

        res.render('display', {
            videos: videos.rows,
            currentPage: page,
            totalPages: totalPages,
            limit: req.query.limit || 10 // Maintain selected limit
        });

    } catch (err) {
        console.error('Error fetching videos:', err);
        res.status(500).send('Error retrieving video records.');
    }
});

// Add this route to handle the edit form submission
app.post('/edit/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const { video_title, channel_id } = req.body;

    try {
        const client = await pool.connect();
        // Update the video title and channel.  Add more fields as necessary.
        const query = `
            UPDATE videos
            SET video_title = $1, channel_id = $2
            WHERE video_id = $3
        `;
        await client.query(query, [video_title, channel_id, videoId]);
        client.release();
        res.redirect('/display'); // Redirect to the display page after editing
    } catch (error) {
        console.error('Error updating video:', error);
        res.status(500).send('Error updating video.');
    }
});

app.get('/edit/:videoId', async (req, res) => {
    const { videoId } = req.params;

    try {
        const client = await pool.connect();
        const query = `
            SELECT
                v.video_id,
                v.video_title,
                v.channel_id,
                c.category_name,
                sc.sub_category_name,
                kd.orator,
                kd.sabha_number
            FROM videos v
            INNER JOIN categories c ON v.category_id = c.category_id
            INNER JOIN sub_categories sc ON v.sub_category_id = sc.sub_category_id
            LEFT JOIN katha_details kd ON v.id = kd.video_id
            WHERE v.video_id = $1
        `;
        const result = await client.query(query, [videoId]);
        client.release();

        if (result.rows.length === 0) {
            return res.status(404).send('Video not found.');
        }

        const video = result.rows[0];
        res.render('edit', { video: video }); // Render the edit.ejs template

    } catch (error) {
        console.error('Error fetching video for edit:', error);
        res.status(500).send('Error retrieving video data.');
    }
});


app.get('/dhun-dashboard', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 10; // Fixed limit per page
        const client = await pool.connect();

        // Get total count for pagination
        const countQuery = `SELECT COUNT(*) FROM ${DHUN_DATA_TABLE}`;
        const countResult = await client.query(countQuery);
        const totalRecords = parseInt(countResult.rows[0].count);
        const totalPages = Math.ceil(totalRecords / limit);

        const query = `
                                        SELECT
                                            video_id,
                                            video_title,
                                            channel_id,
                                            category_name,
                                            sub_category_name
                                        FROM ${DHUN_DATA_TABLE}
                                        ORDER BY video_title ASC
                                        LIMIT $1 OFFSET $2;
                                    `;
        const offset = (page - 1) * limit;
        const result = await client.query(query, [limit, offset]);
        client.release();

        res.render('dhun-dashboard', {
            videos: result.rows,
            currentPage: page,
            totalPages: totalPages,
            exportUrl: '/dhun-dashboard/export'
        });
    } catch (err) {
        console.error('Error loading Dhun Dashboard:', err);
        res.status(500).send('Failed to load Dhun Dashboard');
    }
});

// Route to display streamed dhun table
app.get('/streamed-dhun', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 10;
        const client = await pool.connect();

        const countResult = await client.query(`SELECT COUNT(*) FROM ${STREAMED_DHUN_TABLE}`);
        const totalRecords = parseInt(countResult.rows[0].count);
        const totalPages = Math.ceil(totalRecords / limit);
        const offset = (page - 1) * limit;

        const result = await client.query(`SELECT * FROM ${STREAMED_DHUN_TABLE} LIMIT $1 OFFSET $2`, [limit, offset]);
        client.release();

        res.render('streamed-dhun', {
            videos: result.rows,
            currentPage: page,
            totalPages: totalPages,
            exportUrl: '/streamed-dhun/export'
        });
    } catch (error) {
        console.error('Error loading Streamed Dhun table:', error);
        res.status(500).send('Failed to load Streamed Dhun data.');
    }
});

// Route to display lyrical video dhun table
app.get('/lyrical-video-dhun', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 10;
        const client = await pool.connect();

        const countResult = await client.query(`SELECT COUNT(*) FROM ${LYRICAL_DHUN_TABLE}`);
        const totalRecords = parseInt(countResult.rows[0].count);
        const totalPages = Math.ceil(totalRecords / limit);
        const offset = (page - 1) * limit;

        const result = await client.query(`SELECT * FROM ${LYRICAL_DHUN_TABLE} LIMIT $1 OFFSET $2`, [limit, offset]);
        client.release();

        res.render('lyrical-video-dhun', {
            videos: result.rows,
            currentPage: page,
            totalPages: totalPages,
            exportUrl: '/lyrical-video-dhun/export'
        });
    } catch (error) {
        console.error('Error loading Lyrical Video Dhun table:', error);
        res.status(500).send('Failed to load Lyrical Video Dhun data.');
    }
});

// Route to display dhun jukebox table
app.get('/dhun-jukebox', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 10;
        const client = await pool.connect();

        const countResult = await client.query(`SELECT COUNT(*) FROM ${DHUN_JUKEBOX_TABLE}`);
        const totalRecords = parseInt(countResult.rows[0].count);
        const totalPages = Math.ceil(totalRecords / limit);
        const offset = (page - 1) * limit;

        const result = await client.query(`SELECT * FROM ${DHUN_JUKEBOX_TABLE} LIMIT $1 OFFSET $2`, [limit, offset]);
        client.release();

        res.render('dhun-jukebox', {
            videos: result.rows,
            currentPage: page,
            totalPages: totalPages,
            exportUrl: '/dhun-jukebox/export'
        });
    } catch (error) {
        console.error('Error loading Dhun Jukebox table:', error);
        res.status(500).send('Failed to load Dhun Jukebox data.');
    }
});

// --- Export Routes ---

// Function to export data to Excel
async function exportToExcel(res, query, filename) {
    try {
        const client = await pool.connect();
        const result = await client.query(query);
        client.release();

        if (result.rows.length === 0) {
            return res.status(404).send('No data to export.');
        }

        const worksheet = xlsx.utils.json_to_sheet(result.rows);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Data');

        // Set the appropriate content type
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);

        // Send the workbook as a buffer
        const buffer = xlsx.write(workbook, { bookType: 'xlsx', type: 'buffer' });
        res.send(buffer);

    } catch (error) {
        console.error('Export error:', error);
        res.status(500).send('Error exporting data.');
    }
}

// Export Dhun Dashboard data
app.get('/dhun-dashboard/export', (req, res) => {
    const query = `SELECT video_id, video_title, channel_id, category_name, sub_category_name FROM ${DHUN_DATA_TABLE}`;
    exportToExcel(res, query, 'Dhun_Dashboard_Data');
});

// Export Streamed Dhun data
app.get('/streamed-dhun/export', (req, res) => {
    const query = `SELECT * FROM ${STREAMED_DHUN_TABLE}`;
    exportToExcel(res, query, 'Streamed_Dhun_Data');
});

// Export Lyrical Video Dhun data
app.get('/lyrical-video-dhun/export', (req, res) => {
    const query = `SELECT * FROM ${LYRICAL_DHUN_TABLE}`;
    exportToExcel(res, query, 'Lyrical_Video_Dhun_Data');
});

// Export Dhun Jukebox data
app.get('/dhun-jukebox/export', (req, res) => {
    const query = `SELECT * FROM ${DHUN_JUKEBOX_TABLE}`;
    exportToExcel(res, query, 'Dhun_Jukebox_Data');
});

// --- Helper function for generating Dhun Playlist
async function generateDhunPlaylist(client) {
    try {
        await client.query(`DROP TABLE IF EXISTS ${DHUN_PLAYLIST_TABLE}`);

        await client.query(`
                                        CREATE TABLE ${DHUN_PLAYLIST_TABLE} (
                                            id SERIAL PRIMARY KEY,
                                            video_id VARCHAR(255),
                                            video_title VARCHAR(255),
                                            channel_id VARCHAR(255),
                                            category_name VARCHAR(255),
                                            sub_category_name VARCHAR(255),
                                            playlist_order INT
                                        )
                                    `);

        const streamedRes = await client.query(`SELECT * FROM ${STREAMED_DHUN_TABLE}`);
        const lyricalRes = await client.query(`SELECT * FROM ${LYRICAL_DHUN_TABLE}`);
        const jukeboxRes = await client.query(`SELECT * FROM ${DHUN_JUKEBOX_TABLE}`);

        let streamed = streamedRes.rows;
        let lyrical = lyricalRes.rows;
        const jukebox = jukeboxRes.rows;

        if (streamed.length === 0) {
            console.log('No streamed dhun videos available for playlist generation.');
            return;
        }

        // Function to shuffle an array
        const shuffleArray = (array) => {
            for (let i = array.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [array[i], array[j]] = [array[j], array[i]];
            }
        };

        // Shuffle the streamed and lyrical arrays
        shuffleArray(streamed);
        shuffleArray(lyrical);

        let playlist = [];
        let streamIndex = 0, lyricalIndex = 0, jukeboxIndex = 0;
        let order = 1;

        const getNextItem = (arr, index) => arr[index % arr.length];

        while (streamIndex < streamed.length) {
            // Repeat 4 times: 4 streamed + 1 lyrical
            for (let repeat = 0; repeat < 4; repeat++) {
                for (let i = 0; i < 4 && streamIndex < streamed.length; i++) {
                    const item = streamed[streamIndex++];
                    playlist.push({ ...item, playlist_order: order++ });
                }
                const lyricalItem = getNextItem(lyrical, lyricalIndex++);
                playlist.push({ ...lyricalItem, playlist_order: order++ });
            }

            // Then 1 jukebox
            const jukeboxItem = getNextItem(jukebox, jukeboxIndex++);
            playlist.push({ ...jukeboxItem, playlist_order: order++ });
        }

        for (const video of playlist) {
            await client.query(`
                                                INSERT INTO ${DHUN_PLAYLIST_TABLE} (
                                                    video_id, video_title, channel_id, category_name, sub_category_name, playlist_order
                                                ) VALUES ($1, $2, $3, $4, $5, $6)
                                            `, [
                video.video_id,
                video.video_title,
                video.channel_id,
                video.category_name,
                video.sub_category_name,
                video.playlist_order
            ]);
        }

        console.log(`Dhun Playlist Generated with ${playlist.length} entries.`);
    } catch (error) {
        console.error('Error generating Dhun Playlist:', error);
        throw error;
    }
}

// Start the server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});


app.get('/dhun-playlist', async (req, res) => {
    try {
        const client = await pool.connect();

        const result = await client.query(`
                                                SELECT video_id, video_title, channel_id, category_name, sub_category_name, playlist_order
                                                FROM ${DHUN_PLAYLIST_TABLE}
                                                ORDER BY playlist_order ASC
                                            `);

        client.release();

        res.render('dhun-playlist', {
            playlist: result.rows,
            exportUrl: '/dhun-playlist/export'
        });
    } catch (error) {
        console.error('Error loading Dhun Playlist:', error);
        res.status(500).send('Failed to load Dhun Playlist');
    }
});

app.get('/dhun-playlist/export', (req, res) => {
    const query = `
                                        SELECT video_id, video_title, channel_id, category_name, sub_category_name, playlist_order
                                        FROM ${DHUN_PLAYLIST_TABLE}
                                        ORDER BY playlist_order ASC
                                    `;
    exportToExcel(res, query, 'Dhun_Playlist');
});

// --- New route for video filters ---
app.get('/video-filters', async (req, res) => {
    try {
        const client = await pool.connect();
        const result = await client.query(`SELECT * FROM ${VIDEO_FILTERS_TABLE}`);
        client.release();

        const filterTypes = [
            'video_id',
            'video_title',
            'playlist_id',
            'playlist_name',
            'privacy_status',
        ];

        res.render('video-filters', {
            filters: result.rows,
            filterTypes: filterTypes,
            exportUrl: '/video-filters/export', // Add export URL
            importUrl: '/video-filters/import'
        });
    } catch (error) {
        console.error('Error loading video filters:', error);
        res.status(500).send('Failed to load video filters.');
    }
});

// --- Add a new filter ---
app.post('/video-filters/add', async (req, res) => {
    try {
        const { filter_type, filter_value, matched_video_title } = req.body;
        const client = await pool.connect();
        await client.query(
            `INSERT INTO ${VIDEO_FILTERS_TABLE} (filter_type, filter_value, matched_video_title) VALUES ($1, $2, $3)`,
            [filter_type, filter_value, matched_video_title]
        );
        client.release();
        res.redirect('/video-filters');
    } catch (error) {
        console.error('Error adding video filter:', error);
        res.status(500).send('Failed to add video filter.');
    }
});

// --- Delete a filter ---
app.post('/video-filters/delete/:filter_id', async (req, res) => {
    try {
        const { filter_id } = req.params;
        const client = await pool.connect();
        await client.query(`DELETE FROM ${VIDEO_FILTERS_TABLE} WHERE filter_id = $1`, [filter_id]);
        client.release();
        res.redirect('/video-filters');
    } catch (error) {
        console.error('Error deleting video filter:', error);
        res.status(500).send('Failed to delete video filter.');
    }
});

// --- Export Video Filters ---
app.get('/video-filters/export', (req, res) => {
    const query = `SELECT filter_id, filter_type, filter_value, matched_video_title, timestamp FROM ${VIDEO_FILTERS_TABLE}`;
    exportToExcel(res, query, 'Video_Filters');
});

// --- Import Video Filters ---
app.post('/video-filters/import', upload.single('excelFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send('Please upload an Excel file.');
        }

        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(worksheet);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const row of data) {
                //  filter_id,  timestamp are auto-generated, and matched_video_title was added later.
                const filter_type = row.filter_type;
                const filter_value = row.filter_value;
                const matched_video_title = row.matched_video_title || ''; //handle undefined
                if (filter_type && filter_value) {  // important:  skip rows with missing data.
                    await client.query(
                        `INSERT INTO ${VIDEO_FILTERS_TABLE} (filter_type, filter_value, matched_video_title) VALUES ($1, $2, $3)`,
                        [filter_type, filter_value, matched_video_title]
                    );
                }
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error importing video filters:', error);
            return res.status(500).send('Error importing video filters.');
        } finally {
            client.release();
        }

        res.redirect('/video-filters');
    } catch (error) {
        console.error('Error handling file upload:', error);
        res.status(500).send('Internal server error.');
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
