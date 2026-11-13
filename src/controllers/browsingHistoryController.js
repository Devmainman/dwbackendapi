import { escapeRegex } from '../utils/validation.js';
import BrowsingHistory from '../models/BrowsingHistory.js';
import useragent from 'useragent';
import Setting from '../models/Setting.js';
import pkg from 'tldjs';
const { getDomain } = pkg;
import url from 'url';

// Store active sessions
const activeSessions = new Map();

// Generate unique session ID
const generateSessionId = (ip, userId) => {
  return `${ip}_${userId || 'guest'}_${Date.now()}`;
};

export const getBrowsingHistory = async (req, res) => {
  try {
    const {
      search = '',
      role = 'all',
      sortBy = 'date',
      sortOrder = 'desc',
      page = 1,
      limit = 10
    } = req.query;

    // Get settings for frontend domain
    const settings = await Setting.findOne();
    const frontendURL = settings?.frontendURL || 'http://localhost:1200';
    const frontendDomain = url.parse(frontendURL).hostname || getDomain(frontendURL);

    const query = process.env.NODE_ENV === 'development' ? {} : { domain: frontendDomain };

    if (search) {
      query.$or = [
        { ip: { $regex: escapeRegex(search), $options: 'i' } },
        { domain: { $regex: escapeRegex(search), $options: 'i' } },
        { userRole: { $regex: escapeRegex(search), $options: 'i' } },
        { sessionId: { $regex: escapeRegex(search), $options: 'i' } }
      ];
    }

    if (role !== 'all') {
      query.userRole = role;
    }

    // Sorting
    const sort = {};
    if (sortBy === 'date') sort.updatedAt = sortOrder === 'asc' ? 1 : -1;
    else if (sortBy === 'domain') sort.domain = sortOrder === 'asc' ? 1 : -1;
    else if (sortBy === 'role') sort.userRole = sortOrder === 'asc' ? 1 : -1;
    else if (sortBy === 'pages') sort['basicInfo.pagesVisited'] = sortOrder === 'asc' ? 1 : -1;

    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await BrowsingHistory.countDocuments(query);
    
    const history = await BrowsingHistory.find(query)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Calculate session duration for each session
    const enhancedHistory = history.map(session => {
      if (session.visitedPages && session.visitedPages.length > 0) {
        const firstVisit = new Date(session.visitedPages[0].timestamp);
        const lastVisit = new Date(session.visitedPages[session.visitedPages.length - 1].timestamp);
        const durationMs = lastVisit - firstVisit;
        const durationMinutes = Math.floor(durationMs / (1000 * 60));
        const durationSeconds = Math.floor((durationMs % (1000 * 60)) / 1000);
        
        return {
          ...session,
          sessionDuration: `${durationMinutes}m ${durationSeconds}s`,
          pagesVisited: session.visitedPages.length
        };
      }
      return session;
    });

    res.json({
      success: true,
      data: enhancedHistory,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Error fetching browsing history:', {
      message: error.message,
      userId: req.user?._id
    });
    res.status(500).json({
      success: false,
      message: 'Server error fetching browsing history'
    });
  }
};

export const recordVisit = async (req, res) => {
  try {
    const { url, timestamp, sessionId: clientSessionId } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const user = req.user || null;
    const domain = req.hostname;

    const agent = useragent.parse(req.headers['user-agent'] || '');

    // Check for existing session ID from client or generate new one
    let sessionId = clientSessionId;
    const sessionKey = `${ip}_${user?._id || 'guest'}`;

    // If no session ID provided, check if there's an active session
    if (!sessionId) {
      const activeSession = activeSessions.get(sessionKey);
      if (activeSession && activeSession.expires > Date.now()) {
        sessionId = activeSession.sessionId;
      } else {
        // Create new session
        sessionId = generateSessionId(ip, user?._id);
        activeSessions.set(sessionKey, {
          sessionId,
          expires: Date.now() + (30 * 60 * 1000) // 30 minutes
        });
      }
    } else {
      // Renew existing session
      activeSessions.set(sessionKey, {
        sessionId,
        expires: Date.now() + (30 * 60 * 1000) // 30 minutes
      });
    }

    const visit = {
      url,
      timestamp: timestamp || new Date(),
    };

    // Try to find existing session document
    let session = await BrowsingHistory.findOne({ 
      sessionId, 
      domain,
      userId: user?._id || null
    });

    if (session) {
      // ✅ Add visit to existing session
      session.visitedPages.push(visit);
      session.basicInfo.pagesVisited += 1;
      
      // Update session duration
      if (session.visitedPages.length > 1) {
        const firstVisit = new Date(session.visitedPages[0].timestamp);
        const lastVisit = new Date(visit.timestamp);
        const durationMs = lastVisit - firstVisit;
        session.basicInfo.sessionDuration = `${Math.floor(durationMs / (1000 * 60))}m ${Math.floor((durationMs % (1000 * 60)) / 1000)}s`;
      }
      
      await session.save();
    } else {
      // ✅ Create new session
      const basicInfo = {
        device: agent.device.toString() || 'Unknown',
        os: agent.os.toString() || 'Unknown',
        browser: agent.toAgent() || 'Unknown',
        resolution: req.headers['viewport'] || '',
        language: req.headers['accept-language']?.split(',')[0] || 'Unknown',
        referrer: req.headers['referer'] || '',
        pagesVisited: 1,
        sessionDuration: '0m 0s',
        interactions: 0
      };

      session = await BrowsingHistory.create({
        ip,
        domain,
        sessionId,
        userId: user?._id || null,
        userRole: user?.role || 'Guest',
        basicInfo,
        visitedPages: [visit],
        date: new Date() // Start of session
      });
    }

    res.status(200).json({ 
      success: true, 
      data: session,
      sessionId // Send back session ID for client to store
    });

  } catch (err) {
    console.error('❌ Error recording visit:', err);
    res.status(500).json({ success: false, message: 'Failed to record visit' });
  }
};

// End session (call when user logs out or closes browser)
export const endSession = async (req, res) => {
  try {
    const { sessionId } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const user = req.user || null;
    const sessionKey = `${ip}_${user?._id || 'guest'}`;

    // Remove from active sessions
    activeSessions.delete(sessionKey);

    if (sessionId) {
      const session = await BrowsingHistory.findOne({ sessionId });
      if (session) {
        // Calculate final session duration
        if (session.visitedPages.length > 0) {
          const firstVisit = new Date(session.visitedPages[0].timestamp);
          const lastVisit = new Date(session.visitedPages[session.visitedPages.length - 1].timestamp);
          const durationMs = lastVisit - firstVisit;
          session.basicInfo.sessionDuration = `${Math.floor(durationMs / (1000 * 60))}m ${Math.floor((durationMs % (1000 * 60)) / 1000)}s`;
          await session.save();
        }
      }
    }

    res.status(200).json({ success: true, message: 'Session ended' });
  } catch (err) {
    console.error('❌ Error ending session:', err);
    res.status(500).json({ success: false, message: 'Failed to end session' });
  }
};

// Get session details with all visited pages
export const getSessionDetails = async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const session = await BrowsingHistory.findOne({ sessionId })
      .populate('userId', 'username email')
      .lean();

    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    // Calculate session duration
    let sessionDuration = '0m 0s';
    if (session.visitedPages && session.visitedPages.length > 0) {
      const firstVisit = new Date(session.visitedPages[0].timestamp);
      const lastVisit = new Date(session.visitedPages[session.visitedPages.length - 1].timestamp);
      const durationMs = lastVisit - firstVisit;
      const minutes = Math.floor(durationMs / (1000 * 60));
      const seconds = Math.floor((durationMs % (1000 * 60)) / 1000);
      sessionDuration = `${minutes}m ${seconds}s`;
    }

    res.json({
      success: true,
      data: {
        ...session,
        sessionDuration,
        pagesVisited: session.visitedPages?.length || 0
      }
    });
  } catch (error) {
    console.error('Error fetching session details:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};