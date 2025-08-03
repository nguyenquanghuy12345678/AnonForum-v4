const crypto = require('crypto');

// Input sanitization middleware
const sanitizeInput = (req, res, next) => {
    try {
        // Recursively sanitize all string inputs
        const sanitizeObject = (obj) => {
            for (const key in obj) {
                if (typeof obj[key] === 'string') {
                    // Remove potentially dangerous characters
                    obj[key] = obj[key]
                        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags
                        .replace(/javascript:/gi, '') // Remove javascript: protocol
                        .replace(/data:/gi, '') // Remove data: protocol
                        .replace(/vbscript:/gi, '') // Remove vbscript: protocol
                        .replace(/on\w+\s*=/gi, '') // Remove event handlers like onclick=
                        .trim();
                } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                    sanitizeObject(obj[key]);
                }
            }
        };

        if (req.body) sanitizeObject(req.body);
        if (req.query) sanitizeObject(req.query);
        if (req.params) sanitizeObject(req.params);

        next();
    } catch (error) {
        console.error('Sanitization error:', error);
        res.status(400).json({ error: 'Invalid input data' });
    }
};

// Input validation middleware
const validateInput = (req, res, next) => {
    try {
        // Check for suspicious patterns
        const suspiciousPatterns = [
            /union\s+select/gi,
            /drop\s+table/gi,
            /insert\s+into/gi,
            /delete\s+from/gi,
            /<iframe/gi,
            /<object/gi,
            /<embed/gi,
            /eval\s*\(/gi,
            /setTimeout\s*\(/gi,
            /setInterval\s*\(/gi
        ];

        const checkSuspicious = (obj) => {
            for (const key in obj) {
                if (typeof obj[key] === 'string') {
                    for (const pattern of suspiciousPatterns) {
                        if (pattern.test(obj[key])) {
                            return true;
                        }
                    }
                } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                    if (checkSuspicious(obj[key])) return true;
                }
            }
            return false;
        };

        if (checkSuspicious(req.body) || checkSuspicious(req.query)) {
            console.warn('Suspicious activity detected:', {
                ip: req.ip,
                userAgent: req.get('User-Agent'),
                path: req.path,
                method: req.method,
                body: JSON.stringify(req.body).substring(0, 200)
            });
            
            return res.status(403).json({ error: 'Suspicious activity detected' });
        }

        next();
    } catch (error) {
        console.error('Validation error:', error);
        next();
    }
};

// Hash IP for privacy
const hashIP = (ip) => {
    const salt = process.env.IP_SALT || 'anonforum-salt-2024';
    return crypto.createHash('sha256').update(ip + salt).digest('hex');
};

// Content filtering for inappropriate content
const contentFilter = (req, res, next) => {
    try {
        const { title, content } = req.body;
        
        // Basic spam detection patterns
        const spamPatterns = [
            /(.)\1{10,}/, // Repeated characters (10+ times)
            /(https?:\/\/[^\s]+){3,}/, // Multiple URLs
            /[A-Z]{20,}/, // All caps (20+ chars)
            /(.{1,20})\1{3,}/, // Repeated phrases
            /(buy now|click here|urgent|limited time)/gi, // Common spam phrases
            /\b(viagra|casino|lottery|winner)\b/gi // Spam keywords
        ];

        const checkSpam = (text) => {
            if (!text) return false;
            
            for (const pattern of spamPatterns) {
                if (pattern.test(text)) {
                    return true;
                }
            }
            return false;
        };

        if (checkSpam(title) || checkSpam(content)) {
            console.warn('Spam content detected:', {
                ip: req.ip,
                title: title?.substring(0, 50),
                content: content?.substring(0, 100)
            });
            
            return res.status(400).json({ 
                error: 'Content appears to be spam or violates community guidelines' 
            });
        }

        next();
    } catch (error) {
        console.error('Content filter error:', error);
        next();
    }
};

// Rate limiting helper
const createRateLimit = (windowMs, max, message) => {
    const requests = new Map();
    
    return (req, res, next) => {
        const key = hashIP(req.ip);
        const now = Date.now();
        
        // Clean old entries
        for (const [ip, data] of requests) {
            if (now - data.resetTime > windowMs) {
                requests.delete(ip);
            }
        }
        
        // Check current IP
        if (!requests.has(key)) {
            requests.set(key, { count: 1, resetTime: now });
            return next();
        }
        
        const data = requests.get(key);
        
        if (now - data.resetTime > windowMs) {
            // Reset window
            data.count = 1;
            data.resetTime = now;
            return next();
        }
        
        if (data.count >= max) {
            return res.status(429).json({ 
                error: message,
                retryAfter: Math.ceil((windowMs - (now - data.resetTime)) / 1000)
            });
        }
        
        data.count++;
        next();
    };
};

// Request size limiter
const requestSizeLimiter = (req, res, next) => {
    const contentLength = req.get('Content-Length');
    const maxSize = 50 * 1024; // 50KB
    
    if (contentLength && parseInt(contentLength) > maxSize) {
        console.warn('Request too large:', {
            size: contentLength,
            ip: req.ip,
            path: req.path
        });
        
        return res.status(413).json({ error: 'Request too large' });
    }
    
    next();
};

// CORS headers for security
const securityHeaders = (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    
    // Remove server information
    res.removeHeader('X-Powered-By');
    
    next();
};

// Validate post data
const validatePostData = (req, res, next) => {
    const { title, content, category, tags } = req.body;
    const errors = [];
    
    // Title validation
    if (!title || typeof title !== 'string') {
        errors.push('Title is required');
    } else if (title.trim().length < 3) {
        errors.push('Title must be at least 3 characters');
    } else if (title.trim().length > 200) {
        errors.push('Title cannot exceed 200 characters');
    }
    
    // Content validation
    if (!content || typeof content !== 'string') {
        errors.push('Content is required');
    } else if (content.trim().length < 10) {
        errors.push('Content must be at least 10 characters');
    } else if (content.trim().length > 2000) {
        errors.push('Content cannot exceed 2000 characters');
    }
    
    // Category validation
    const validCategories = ['general', 'tech', 'crypto', 'society', 'confession', 'question', 'random'];
    if (!category || !validCategories.includes(category)) {
        errors.push('Valid category is required');
    }
    
    // Tags validation
    if (tags && Array.isArray(tags)) {
        if (tags.length > 5) {
            errors.push('Maximum 5 tags allowed');
        }
        
        for (const tag of tags) {
            if (typeof tag !== 'string' || tag.length > 50) {
                errors.push('Each tag must be a string with maximum 50 characters');
                break;
            }
        }
    }
    
    if (errors.length > 0) {
        return res.status(400).json({ 
            error: 'Validation failed', 
            details: errors 
        });
    }
    
    next();
};

// Validate comment data
const validateCommentData = (req, res, next) => {
    const { content } = req.body;
    const errors = [];
    
    if (!content || typeof content !== 'string') {
        errors.push('Comment content is required');
    } else if (content.trim().length < 1) {
        errors.push('Comment cannot be empty');
    } else if (content.trim().length > 1000) {
        errors.push('Comment cannot exceed 1000 characters');
    }
    
    if (errors.length > 0) {
        return res.status(400).json({ 
            error: 'Validation failed', 
            details: errors 
        });
    }
    
    next();
};

// Log suspicious activity
const logSuspiciousActivity = (req, activity) => {
    console.warn('🚨 Suspicious activity:', {
        activity,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString()
    });
};

// Simple honeypot trap
const honeypotTrap = (req, res, next) => {
    // Check for honeypot field (should be empty)
    if (req.body.honeypot && req.body.honeypot.trim() !== '') {
        logSuspiciousActivity(req, 'Honeypot triggered');
        return res.status(403).json({ error: 'Forbidden' });
    }
    
    // Remove honeypot field
    delete req.body.honeypot;
    next();
};

module.exports = {
    sanitizeInput,
    validateInput,
    hashIP,
    contentFilter,
    createRateLimit,
    requestSizeLimiter,
    securityHeaders,
    validatePostData,
    validateCommentData,
    logSuspiciousActivity,
    honeypotTrap
};