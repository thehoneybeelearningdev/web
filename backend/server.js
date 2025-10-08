/*
Required Environment Variables:
RAZORPAY_KEY_ID=your_razorpay_key_id
RAZORPAY_KEY_SECRET=your_razorpay_key_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
CLIENT_URL=your_frontend_url
PORT=5000
*/

/* eslint-env node */
/* global require, process, Buffer */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const bodyParser = require('body-parser');
const { db: adminDb, admin } = require('./config/firebaseAdmin');
const authRoutes = require('./routes/auth');
const fileRoutes = require('./routes/files');
const cookieParser = require('cookie-parser');
const { connectDB } = require('./config/mongodb');

const app = express();
const PORT = process.env.PORT || 5000;

// Connect to MongoDB
connectDB();

// CORS Configuration
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true
}));

// Raw body parser for webhook (must be before other body parsers)
app.use('/api/payment/webhook', bodyParser.raw({ type: 'application/json' }));

// Middleware
app.use(express.json());
app.use(cookieParser());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/files', fileRoutes);

// Razorpay Setup
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
 
  process.exit(1);
}

const FieldValue = admin.firestore.FieldValue;

// Create Enrollment API
app.post('/api/enrollment/create', async (req, res) => {
  try {

    const { userId, courseId, studentName, email, phone, courseTitle, amount } = req.body;

    // Validate required fields
    if (!userId || !courseId || !email || !courseTitle || !amount) {
      return res.status(400).json({
        error: 'Missing required fields: userId, courseId, email, courseTitle, amount'
      });
    }

    // Check if enrollment already exists
    const existingEnrollments = await adminDb.collection('enrollments')
      .where('userId', '==', userId)
      .where('courseId', '==', courseId)
      .get();

    if (!existingEnrollments.empty) {
      const existingEnrollment = existingEnrollments.docs[0];
      const enrollmentData = existingEnrollment.data();

      if (enrollmentData.status === 'Paid') {
        return res.status(400).json({
          error: 'Student is already enrolled in this course'
        });
      }

      // Return existing pending enrollment
      return res.json({
        enrollmentId: existingEnrollment.id,
        status: 'exists',
        message: 'Pending enrollment already exists'
      });
    }

    // Create new enrollment
    const enrollmentId = uuidv4();
    const enrollmentData = {
      enrollmentId,
      userId,
      courseId,
      studentName: studentName || '',
      email,
      phone: phone || '',
      courseTitle,
      amount: parseInt(amount),
      currency: 'INR',
      status: 'Pending',
      paymentStatus: 'Pending', // For backward compatibility
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    await adminDb.collection('enrollments').doc(enrollmentId).set(enrollmentData);

    res.json({
      enrollmentId,
      status: 'created',
      message: 'Enrollment created successfully'
    });

  } catch (error) {
 
    res.status(500).json({
      error: 'Failed to create enrollment',
      message: error.message
    });
  }
});

// Payment: Create Order
app.post('/api/payment/order', async (req, res) => {
  try {

    const { enrollmentId, userId, courseId, amount, currency = 'INR', customerEmail, customerContact, notes = {} } = req.body;

    // Validate required fields
    if (!enrollmentId || !userId || !courseId || !amount || !customerEmail) {
      return res.status(400).json({
        error: 'Missing required fields: enrollmentId, userId, courseId, amount, customerEmail'
      });
    }

    // Verify enrollment exists and is pending
    const enrollmentDoc = await adminDb.collection('enrollments').doc(enrollmentId).get();
    if (!enrollmentDoc.exists) {
      return res.status(404).json({
        error: 'Enrollment not found'
      });
    }

    const enrollmentData = enrollmentDoc.data();
    if (enrollmentData.status === 'Paid') {
      return res.status(400).json({
        error: 'Enrollment is already paid'
      });
    }

    // Create Razorpay order
    const orderOptions = {
      amount: parseInt(amount), // amount in paise
      currency,
      receipt: enrollmentId, // Use enrollmentId as receipt
      notes: {
        ...notes,
        enrollmentId,
        userId,
        courseId,
        customerEmail
      }
    };

    const razorpayOrder = await razorpay.orders.create(orderOptions);

    // Update enrollment with Razorpay order details
    await adminDb.collection('enrollments').doc(enrollmentId).update({
      razorpayOrderId: razorpayOrder.id,
      customerEmail,
      customerContact: customerContact || null,
      notes,
      updatedAt: FieldValue.serverTimestamp(),
      rawWebhookEvents: []
    });



    // Return order details to frontend
    res.json({
      orderId: razorpayOrder.id,
      key: process.env.RAZORPAY_KEY_ID,
      amount: parseInt(amount),
      currency,
      enrollmentId
    });

  } catch (error) {
   
    res.status(500).json({
      error: 'Failed to create payment order',
      message: error.message
    });
  }
});

// Webhook signature verification function
function verifyWebhookSignature(body, signature, secret) {
  try {
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');

    const actualSignature = signature.replace('sha256=', '');

    // Use timing-safe comparison
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(actualSignature, 'hex')
    );
  } catch (error) {
    return false;
  }
}

// Razorpay Webhook
app.post('/api/payment/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const body = req.body;



    if (!signature) {
      return res.status(400).json({ error: 'Missing signature' });
    }

    // Verify webhook signature
    const isValidSignature = verifyWebhookSignature(
      body,
      signature,
      process.env.RAZORPAY_WEBHOOK_SECRET
    );

    if (!isValidSignature) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(body.toString());


    // Log raw webhook event

    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;
      const orderId = payment.order_id;
      const paymentId = payment.id;



      // Get order details from Razorpay to find receipt (enrollmentId)
      let enrollmentId = null;
      let enrollmentDoc = null;

      try {
        // Get order details from Razorpay
        const orderDetails = await razorpay.orders.fetch(orderId);
        enrollmentId = orderDetails.receipt; // This should be our enrollmentId

        if (enrollmentId) {
          enrollmentDoc = await adminDb.collection('enrollments').doc(enrollmentId).get();
        }
      } catch (error) {
        // Error fetching order details
      }

      // Fallback: Find by enrollmentId in payment notes
      if (!enrollmentDoc || !enrollmentDoc.exists) {
        if (payment.notes && payment.notes.enrollmentId) {
          enrollmentId = payment.notes.enrollmentId;
          enrollmentDoc = await adminDb.collection('enrollments').doc(enrollmentId).get();
        }
      }

      // Fallback: Search by razorpayOrderId
      if (!enrollmentDoc || !enrollmentDoc.exists) {
        const enrollmentQuery = await adminDb.collection('enrollments')
          .where('razorpayOrderId', '==', orderId)
          .limit(1)
          .get();

        if (!enrollmentQuery.empty) {
          enrollmentDoc = enrollmentQuery.docs[0];
          enrollmentId = enrollmentDoc.id;
        }
      }

      if (!enrollmentDoc || !enrollmentDoc.exists) {
        return res.status(404).json({ error: 'Enrollment not found' });
      }

      // Update enrollment status to Paid
      const updateData = {
        status: 'Paid',
        paymentStatus: 'Paid', // For backward compatibility
        razorpayPaymentId: paymentId,
        paymentMethod: payment.method || null,
        signature: signature,
        paidAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        rawWebhookEvents: FieldValue.arrayUnion(event)
      };

      await adminDb.collection('enrollments').doc(enrollmentId).update(updateData);

      // Emit real-time update for admin panel

    } else {
      // Handle other webhook events if needed
    }

    res.json({ status: 'ok' });

  } catch (error) {
    res.status(500).json({
      error: 'Webhook processing failed',
      message: error.message
    });
  }
});

// Get Enrollment Status API
app.get('/api/enrollment/:enrollmentId/status', async (req, res) => {
  try {
    const { enrollmentId } = req.params;

    const enrollmentDoc = await adminDb.collection('enrollments').doc(enrollmentId).get();

    if (!enrollmentDoc.exists) {
      return res.status(404).json({ error: 'Enrollment not found' });
    }

    const enrollmentData = enrollmentDoc.data();

    res.json({
      enrollmentId,
      status: enrollmentData.status,
      paymentStatus: enrollmentData.paymentStatus,
      razorpayPaymentId: enrollmentData.razorpayPaymentId || null,
      updatedAt: enrollmentData.updatedAt
    });

  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch enrollment status',
      message: error.message
    });
  }
});

// Payment: Verify (keeping for backward compatibility)
app.post('/api/payment/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment verification details' });
    }

    const sign = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSign = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(sign.toString())
      .digest('hex');

    if (razorpay_signature === expectedSign) {
      return res.status(200).json({ message: 'Payment verified successfully' });
    } else {
      return res.status(400).json({ error: 'Invalid payment signature' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Payment verification failed', details: error.message });
  }
});

// Delete Teacher with Auth cleanup
app.delete('/api/admin/delete-teacher/:teacherId', async (req, res) => {
  try {
    const { teacherId } = req.params;

    // Get teacher data first
    const teacherRef = adminDb.collection('Teacher').doc(teacherId);
    const teacherSnap = await teacherRef.get();

    if (!teacherSnap.exists) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    const teacherData = teacherSnap.data();
    const email = teacherData.email || teacherData.Gmail;

    // Delete from Firebase Auth if email exists
    if (email) {
      try {
        // Get user by email from Firebase Auth
        const userRecord = await admin.auth().getUserByEmail(email);
        
        // Delete user from Firebase Auth
        await admin.auth().deleteUser(userRecord.uid);
      } catch (authError) {
        // User might not exist in Auth or other error
        // Continue with Firestore deletion even if Auth deletion fails
      }
    }

    // Delete the target doc first
    await teacherRef.delete();

    // Find and delete all other Teacher docs with the same email
    if (email) {
      const emailLower = email.toLowerCase().trim();
      const q = adminDb.collection('Teacher').where('email', 'in', [email, emailLower])
        .limit(10); // Add limit for safety

      const querySnapshot = await q.get();
      const deletePromises = [];

      querySnapshot.forEach((doc) => {
        if (doc.id !== teacherId) { // Skip the one we already deleted
          deletePromises.push(doc.ref.delete());
        }
      });

      await Promise.all(deletePromises);
    }

    res.json({ 
      success: true, 
      message: 'Teacher and all associated profiles deleted successfully!' 
    });

  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to delete teacher', 
      message: error.message 
    });
  }
});

// Delete Student with Auth cleanup
app.delete('/api/admin/delete-student/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;

    // Get student data first
    const studentRef = adminDb.collection('Students').doc(studentId);
    const studentSnap = await studentRef.get();

    if (!studentSnap.exists) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const studentData = studentSnap.data();
    const email = studentData.email || studentData.Gmail;

    // Delete from Firebase Auth if email exists
    if (email) {
      try {
        // Get user by email from Firebase Auth
        const userRecord = await admin.auth().getUserByEmail(email);
        
        // Delete user from Firebase Auth
        await admin.auth().deleteUser(userRecord.uid);
      } catch (authError) {
        // User might not exist in Auth or other error
        // Continue with Firestore deletion even if Auth deletion fails
      }
    }

    // Delete the target doc first
    await studentRef.delete();

    // Find and delete all other Student docs with the same email
    if (email) {
      const emailLower = email.toLowerCase().trim();
      const q = adminDb.collection('Students').where('email', 'in', [email, emailLower])
        .limit(10); // Add limit for safety

      const querySnapshot = await q.get();
      const deletePromises = [];

      querySnapshot.forEach((doc) => {
        if (doc.id !== studentId) { // Skip the one we already deleted
          deletePromises.push(doc.ref.delete());
        }
      });

      await Promise.all(deletePromises);
    }

    res.json({ 
      success: true, 
      message: 'Student and all associated profiles deleted successfully!' 
    });

  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to delete student', 
      message: error.message 
    });
  }
});

// ===================
// Zoom automation (no frontend changes required)
// ===================

async function getZoomAccessToken() {
  try {
    const accountId = process.env.ZOOM_ACCOUNT_ID;
    const clientId = process.env.ZOOM_CLIENT_ID;
    const clientSecret = process.env.ZOOM_CLIENT_SECRET;
    if (!accountId || !clientId || !clientSecret) return null;

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`;
    const res = await zoomApiCall(() => axios.post(url, null, { headers: { Authorization: `Basic ${basic}` } }));
    return res.data && res.data.access_token ? res.data.access_token : null;
  } catch (err) {
    return null;
  }
}

async function createZoomMeeting(topic) {
  const token = await getZoomAccessToken();
  if (!token) {
    // Fallback to static link if provided
    const fallback = process.env.DEFAULT_ZOOM_LINK || null;
    if (!fallback) return { joinUrl: null, startUrl: null, id: null };
    return { joinUrl: fallback, startUrl: fallback, id: 'static' };
  }
  try {
    const res = await zoomApiCall(() => axios.post(
      'https://api.zoom.us/v2/users/me/meetings',
      {
        topic: topic || 'Class Session',
        // Recurring meeting with no fixed time → evergreen join URL
        type: 3,
        settings: {
          join_before_host: true,
          approval_type: 2,
          waiting_room: false,
          mute_upon_entry: true,
        },
      },
      { headers: { Authorization: `Bearer ${token}` } }
    ));
    return {
      joinUrl: res.data?.join_url || null,
      startUrl: res.data?.start_url || null,
      id: res.data?.id || null,
    };
  } catch (err) {
    const fallback = process.env.DEFAULT_ZOOM_LINK || null;
    return { joinUrl: fallback, startUrl: fallback, id: 'static' };
  }
}

async function isMeetingValid(meetingId) {
  try {
    if (!meetingId || meetingId === 'static') return false;
    const token = await getZoomAccessToken();
    if (!token) return false;
    const url = `https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}`;
    const res = await zoomApiCall(() => axios.get(url, { headers: { Authorization: `Bearer ${token}` } }));
    // 200 means meeting exists and is usable
    return !!res?.data?.id;
  } catch (err) {
    const code = err?.response?.data?.code;
    // 3001: Meeting does not exist or has expired; 404 similarly
    if (code === 3001 || err?.response?.status === 404) return false;
    // Any other API failure: assume valid to avoid thrashing
    return true;
  }
}

// ----------------------------
// Simple rate limiter + retry for Zoom API to avoid 429
// ----------------------------
const zoomTaskQueue = [];
let zoomWorkerRunning = false;
const PER_REQUEST_DELAY_MS = 400; // about 2.5 requests/sec

function startZoomWorkerIfNeeded() {
  if (zoomWorkerRunning) return;
  zoomWorkerRunning = true;
  const work = async () => {
    const task = zoomTaskQueue.shift();
    if (!task) {
      zoomWorkerRunning = false;
      return;
    }
    try {
      await task();
    } catch { /* swallow; caller handles */ }
    setTimeout(work, PER_REQUEST_DELAY_MS + Math.floor(Math.random() * 120));
  };
  work();
}

function zoomApiCall(fn, maxRetries = 5) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const exec = () => {
      attempt += 1;
      fn()
        .then(resolve)
        .catch((err) => {
          const status = err?.response?.status;
          const code = err?.response?.data?.code;
          if ((status === 429 || code === 429) && attempt < maxRetries) {
            const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 8000) + Math.floor(Math.random() * 250);
            setTimeout(() => {
              zoomTaskQueue.push(exec);
              startZoomWorkerIfNeeded();
            }, backoff);
            return;
          }
          reject(err);
        });
    };
    zoomTaskQueue.push(exec);
    startZoomWorkerIfNeeded();
  });
}

async function ensureCourseZoom(courseRef, data) {
  try {
    const isStatic = (data.zoomMeetingId === 'static') ||
      (typeof data.zoomLink === 'string' && /your-static-zoom-link/i.test(data.zoomLink));
    const hasLink = !!data.zoomLink && !isStatic;
    if (hasLink) {
      // Validate existing meeting; rotate if invalid
      const valid = await isMeetingValid(data.zoomMeetingId);
      if (valid) return;
    }
    const title = data.name || data.courseName || 'Course Session';
    const meeting = await createZoomMeeting(title);
    if (!meeting.joinUrl) return;
    await courseRef.set(
      {
        zoomLink: meeting.joinUrl,
        zoomMeetingId: meeting.id,
        zoomStartUrl: meeting.startUrl,
      },
      { merge: true }
    );
  } catch (err) {
    // Error ensuring course zoom
  }
}

async function ensureBatchZoom(batchRef, data) {
  try {
    const batchId = batchRef.id;
    let { zoomLink, zoomMessageId, zoomMeetingId } = data;
    const isStatic = (zoomMeetingId === 'static') || (typeof zoomLink === 'string' && /your-static-zoom-link/i.test(zoomLink));

    // 1) Ensure zoomLink exists
    let needsCreate = !zoomLink || isStatic;
    if (!needsCreate && zoomMeetingId) {
      const valid = await isMeetingValid(zoomMeetingId);
      needsCreate = !valid;
    }
    if (needsCreate) {
      const topic = data.batchName || data.courseName || 'Batch Session';
      const meeting = await createZoomMeeting(topic);
      if (meeting.joinUrl) {
        await batchRef.set(
          {
            zoomLink: meeting.joinUrl,
            zoomMeetingId: meeting.id,
            zoomStartUrl: meeting.startUrl,
          },
          { merge: true }
        );
        zoomLink = meeting.joinUrl;
      }
    }

    // 2) Ensure pinned message exists (far-past timestamp so it stays first like a pinned banner)
    if (zoomLink && !zoomMessageId) {
      const msgRef = await batchRef.collection('messages').add({
        text: `Join Zoom: ${zoomLink}`,
        senderId: 'admin',
        senderName: 'Admin',
        senderRole: 'admin',
        isPinned: true, // Add this field
        // Far past so this message sorts first (UI orders ascending by timestamp)
        timestamp: admin.firestore.Timestamp.fromDate(new Date(2000, 0, 1)),
      });
      await batchRef.set({ zoomMessageId: msgRef.id }, { merge: true });
      zoomMessageId = msgRef.id;
    }

    // 3) If link changed later, keep pinned message text in sync
    if (zoomLink && zoomMessageId) {
      const pinnedRef = batchRef.collection('messages').doc(zoomMessageId);
      const pinnedSnap = await pinnedRef.get();
      const currentText = pinnedSnap.exists ? pinnedSnap.data()?.text : '';
      const currentTs = pinnedSnap.exists ? pinnedSnap.data()?.timestamp : null;
      const desired = `Join Zoom: ${zoomLink}`;
      const isPastPinned = (() => {
        try {
          if (!currentTs) return false;
          const d = typeof currentTs.toDate === 'function' ? currentTs.toDate() : new Date(currentTs);
          return d.getFullYear() <= 2000;
        } catch { return false; }
      })();

      if (currentText !== desired || !isPastPinned) {
        await pinnedRef.set({
          text: desired,
          isPinned: true, // Also add here for updates
          // ensure it remains first/visible at top
          timestamp: admin.firestore.Timestamp.fromDate(new Date(2000, 0, 1)),
        }, { merge: true });
      }
    }
  } catch (err) {
    // Error ensuring batch zoom
  }
}

async function ensureChatZoom(chatRef, data) {
  try {
    const chatId = chatRef.id;
    let { zoomLink, zoomMessageId, zoomMeetingId, allowZoomLink } = data;
    
    // Only create zoom link if allowZoomLink is true
    if (!allowZoomLink) {
      return;
    }

    const isStatic = (zoomMeetingId === 'static') || (typeof zoomLink === 'string' && /your-static-zoom-link/i.test(zoomLink));

    // 1) Ensure zoomLink exists
    let needsCreate = !zoomLink || isStatic;
    if (!needsCreate && zoomMeetingId) {
      const valid = await isMeetingValid(zoomMeetingId);
      needsCreate = !valid;
    }
    if (needsCreate) {
      const topic = data.name || data.courseName || 'One-on-One Session';
      const meeting = await createZoomMeeting(topic);
      if (meeting.joinUrl) {
        await chatRef.set(
          {
            zoomLink: meeting.joinUrl,
            zoomMeetingId: meeting.id,
            zoomStartUrl: meeting.startUrl,
            allowZoomLink: true, // Mark that zoom is enabled
          },
          { merge: true }
        );
        zoomLink = meeting.joinUrl;
      }
    }

    // 2) Ensure pinned message exists (far-past timestamp so it stays first like a pinned banner)
    if (zoomLink && !zoomMessageId) {
      const msgRef = await chatRef.collection('messages').add({
        text: `Join Zoom: ${zoomLink}`,
        senderId: 'admin',
        senderName: 'Admin',
        senderRole: 'admin',
        isPinned: true,
        // Far past so this message sorts first (UI orders ascending by timestamp)
        timestamp: admin.firestore.Timestamp.fromDate(new Date(2000, 0, 1)),
      });
      await chatRef.set({ zoomMessageId: msgRef.id }, { merge: true });
      zoomMessageId = msgRef.id;
    }

    // 3) If link changed later, keep pinned message text in sync
    if (zoomLink && zoomMessageId) {
      const pinnedRef = chatRef.collection('messages').doc(zoomMessageId);
      const pinnedSnap = await pinnedRef.get();
      const currentText = pinnedSnap.exists ? pinnedSnap.data()?.text : '';
      const currentTs = pinnedSnap.exists ? pinnedSnap.data()?.timestamp : null;
      const desired = `Join Zoom: ${zoomLink}`;
      const isPastPinned = (() => {
        try {
          if (!currentTs) return false;
          const d = typeof currentTs.toDate === 'function' ? currentTs.toDate() : new Date(currentTs);
          return d.getFullYear() <= 2000;
        } catch { return false; }
      })();

      if (currentText !== desired || !isPastPinned) {
        await pinnedRef.set({
          text: desired,
          isPinned: true,
          // ensure it remains first/visible at top
          timestamp: admin.firestore.Timestamp.fromDate(new Date(2000, 0, 1)),
        }, { merge: true });
      }
    }
  } catch (err) {
    // Error ensuring chat zoom
  }
}

function startZoomAutomation() {
  try {
    // Backfill: ensure chat participants include canonical auth UIDs for visibility
    async function ensureChatParticipants(chatRef, data) {
      try {
        const chatId = chatRef.id;
        const existingUsers = Array.isArray(data.users) ? data.users.slice() : [];
        const updatedUsers = new Set(existingUsers.filter(Boolean));
        let changed = false;

        // Helper to add a value to users set
        const addUser = (val) => {
          if (val && !updatedUsers.has(val)) {
            updatedUsers.add(val);
            changed = true;
          }
        };

        // Resolve student UID variants and include them
        if (data.studentId) {
          try {
            const studentDoc = await adminDb.collection('Students').doc(String(data.studentId)).get();
            if (studentDoc.exists) {
              const s = studentDoc.data() || {};
              // Include the original id (already present) and also uid if available
              addUser(String(data.studentId));
              if (s.uid) addUser(String(s.uid));
              // Fallback: try to locate an auth user in generic 'users' collection by email
              const gmail = String(s.Gmail || s.email || '').toLowerCase();
              if (gmail) {
                try {
                  const byEmail = await adminDb.collection('users').where('email', '==', gmail).limit(1).get();
                  if (!byEmail.empty) {
                    addUser(String(byEmail.docs[0].id));
                  }
                } catch { /* ignore */ }
              }
            } else {
              // In some schemas studentId might be the email; include as-is for visibility
              addUser(String(data.studentId));
            }
          } catch { /* ignore student resolution errors */ }
        }

        // Resolve teacher UID variants and include them
        if (data.teacherId) {
          try {
            const teacherDoc = await adminDb.collection('Teacher').doc(String(data.teacherId)).get();
            if (teacherDoc.exists) {
              const t = teacherDoc.data() || {};
              addUser(String(data.teacherId));
              if (t.uid) addUser(String(t.uid));
              const gmail = String(t.Gmail || t.email || '').toLowerCase();
              if (gmail) {
                try {
                  const byEmail = await adminDb.collection('users').where('email', '==', gmail).limit(1).get();
                  if (!byEmail.empty) {
                    addUser(String(byEmail.docs[0].id));
                  }
                } catch { /* ignore */ }
              }
            } else {
              addUser(String(data.teacherId));
            }
          } catch { /* ignore teacher resolution errors */ }
        }

        // Always include admin for legacy/admin visibility if present previously
        if (existingUsers.includes('admin')) addUser('admin');

        if (changed) {
          await chatRef.set({ users: Array.from(updatedUsers) }, { merge: true });
        }
      } catch (e) {
        // Error ensuring chat participants
      }
    }

    // Backfill: courses
    adminDb.collection('courses').get().then((snap) => {
      snap.docs.forEach((d) => ensureCourseZoom(d.ref, d.data() || {}));
    }).catch(() => {});

    // Backfill: batches
    adminDb.collection('batches').get().then((snap) => {
      snap.docs.forEach((d) => ensureBatchZoom(d.ref, d.data() || {}));
    }).catch(() => {});

    // Backfill: chats (for chat assignments)
    adminDb.collection('chats').get().then((snap) => {
      snap.docs.forEach((d) => {
        const data = d.data() || {};
        ensureChatParticipants(d.ref, data);
        ensureChatZoom(d.ref, data);
      });
    }).catch(() => {});

    // Real-time watchers
    adminDb.collection('courses').onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' || change.type === 'modified') {
          const data = change.doc.data() || {};
          ensureCourseZoom(change.doc.ref, data);
        }
      });
    }, (err) => { /* courses onSnapshot error */ });

    adminDb.collection('batches').onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' || change.type === 'modified') {
          const data = change.doc.data() || {};
          ensureBatchZoom(change.doc.ref, data);
        }
      });
    }, (err) => { /* batches onSnapshot error */ });

    // Real-time watcher for chats
    adminDb.collection('chats').onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' || change.type === 'modified') {
          const data = change.doc.data() || {};
          ensureChatParticipants(change.doc.ref, data);
          ensureChatZoom(change.doc.ref, data);
        }
      });
    }, (err) => { /* chats onSnapshot error */ });



    // Periodic validation to auto-rotate invalid/expired meetings, no frontend changes needed
    const validateAll = async () => {
      try {
        const [batchesSnap, coursesSnap, chatsSnap] = await Promise.all([
          adminDb.collection('batches').get(),
          adminDb.collection('courses').get(),
          adminDb.collection('chats').get(),
        ]);

        // Validate batches sequentially to avoid rate limits
        for (const d of batchesSnap.docs) {
          try { await ensureBatchZoom(d.ref, d.data() || {}); } catch { /* ignore per-doc */ }
        }
        for (const d of coursesSnap.docs) {
          try { await ensureCourseZoom(d.ref, d.data() || {}); } catch { /* ignore per-doc */ }
        }
        for (const d of chatsSnap.docs) {
          try {
            const data = d.data() || {};
            await ensureChatParticipants(d.ref, data);
            await ensureChatZoom(d.ref, data);
          } catch { /* ignore per-doc */ }
        }
      } catch (err) {
        // Error in validateAll
      }
    };
    // Run at start and every 15 minutes
    validateAll();
    setInterval(validateAll, 15 * 60 * 1000);
  } catch (err) {
    // Error starting zoom automation
  }
}

// Start automation when server starts
startZoomAutomation();

// Global Error Handler
app.use((err, req, res, next) => {
  res.status(500).json({ error: 'Internal server error' });
});

// Start Server
app.listen(PORT, () => {
  const serverUrl = process.env.NODE_ENV === 'production' 
    ? 'Production server running' 
    : `Server running on http://localhost:${PORT}`;
});
