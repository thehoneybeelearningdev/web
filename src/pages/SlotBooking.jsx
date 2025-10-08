import React, { useState, useEffect } from 'react';
import { Calendar, Clock, Repeat } from 'lucide-react';
import { db } from '../services/firebase';
import {
  collection,
  doc,
  setDoc,
  onSnapshot,
  addDoc,
  query,
  where,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  arrayUnion,
  arrayRemove,
} from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import '../styles/SlotBooking.css';

const SlotBooking = () => {
  const { currentUser, userRole } = useAuth();
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [slots, setSlots] = useState([
    { 
      id: 1, 
      date: '', 
      fromTime: '', 
      toTime: '', 
      fromPeriod: 'AM', 
      toPeriod: 'AM',
      isRecurring: false,
      recurringType: 'weekly', // 'weekly' or 'monthly'
      recurringDays: [], // ['monday', 'tuesday', etc.]
      endDate: '', // End date for recurring slots
      originalSlotId: null // For tracking recurring slot groups
    },
    { 
      id: 2, 
      date: '', 
      fromTime: '', 
      toTime: '', 
      fromPeriod: 'AM', 
      toPeriod: 'AM',
      isRecurring: false,
      recurringType: 'weekly',
      recurringDays: [],
      endDate: '',
      originalSlotId: null
    },
    { 
      id: 3, 
      date: '', 
      fromTime: '', 
      toTime: '', 
      fromPeriod: 'AM', 
      toPeriod: 'AM',
      isRecurring: false,
      recurringType: 'weekly',
      recurringDays: [],
      endDate: '',
      originalSlotId: null
    }
  ]);
  const [teacherDocId, setTeacherDocId] = useState('');
  const [resolvingTeacher, setResolvingTeacher] = useState(true);
  // Resolve existing Teacher document ID (prefer email == email; do not create new)
  useEffect(() => {
    const resolve = async () => {
      try {
        if (!currentUser) { setTeacherDocId(''); return; }
        // Prefer match by email field (lowercased)
        const email = String(currentUser.email || '').toLowerCase();
        if (email) {
          const byEmail = await getDocs(query(collection(db, 'Teacher'), where('email', '==', email)));
          if (!byEmail.empty) { setTeacherDocId(byEmail.docs[0].id); return; }
          // Try email as document id
          const byEmailDocId = await getDoc(doc(db, 'Teacher', email));
          if (byEmailDocId.exists()) { setTeacherDocId(byEmailDocId.id); return; }
        }
        // Fallbacks: direct doc with uid, or query by uid field
        const byUidDoc = await getDoc(doc(db, 'Teacher', currentUser.uid));
        if (byUidDoc.exists()) { setTeacherDocId(byUidDoc.id); return; }
        const byUid = await getDocs(query(collection(db, 'Teacher'), where('uid', '==', currentUser.uid)));
        if (!byUid.empty) { setTeacherDocId(byUid.docs[0].id); return; }
        setTeacherDocId('');
      } finally {
        setResolvingTeacher(false);
      }
    };
    setResolvingTeacher(true);
    resolve();
  }, [currentUser]);
  // 🔄 Listen to this teacher's slots from Firestore
  useEffect(() => {
    if (!teacherDocId) return;
    const qSlots = query(collection(db, 'teacherSlots'), where('teacherDocId', '==', teacherDocId));
    const unsubscribe = onSnapshot(qSlots, (snapshot) => {
      const fetched = snapshot.docs.map(d => ({ docId: d.id, ...d.data() }));
      setSlots(prev => prev.map(slot => fetched.find(s => Number(s.id) === Number(slot.id)) || slot));
    });
    return () => unsubscribe();
  }, [teacherDocId]);
  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

const handleSave = async () => {
    if (!teacherDocId) { alert('Unable to resolve teacher ID.'); return; }
    try {
      for (const slot of slots) {
        if (slot.date && slot.fromTime && slot.toTime) {
          if (slot.isRecurring && slot.recurringDays.length > 0 && slot.endDate) {
            // Handle recurring slots
            await createRecurringSlots(slot);
          } else {
            // Handle single slot (existing logic)
            await createSingleSlot(slot);
          }
        }
      }
      alert('Slots saved successfully!');
    } catch (error) {
      alert('Failed to save slots');
    }
  };

  const createSingleSlot = async (slot) => {
          const existingSnap = await getDocs(
            query(
              collection(db, 'teacherSlots'),
              where('teacherDocId', '==', teacherDocId),
              where('id', '==', slot.id)
            )
          );

          const payload = {
            id: slot.id,
            date: slot.date,
            fromTime: slot.fromTime,
            toTime: slot.toTime,
            fromPeriod: slot.fromPeriod,
            toPeriod: slot.toPeriod,
            teacherDocId,
      isRecurring: false,
      originalSlotId: null
          };

          if (!existingSnap.empty) {
            const ref = existingSnap.docs[0].ref;
            await setDoc(ref, payload, { merge: true });
          } else {
            const newRef = await addDoc(collection(db, 'teacherSlots'), payload);
            await updateDoc(doc(db, 'Teacher', teacherDocId), {
              mySlots: arrayUnion(newRef.id),
            });
          }
  };

  const createRecurringSlots = async (slot) => {
    const startDate = new Date(slot.date);
    const endDate = new Date(slot.endDate);
    const recurringSlots = [];

    // Generate all recurring dates
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dayName = d.toLocaleDateString('en-US', { weekday: 'lowercase' });
      if (slot.recurringDays.includes(dayName)) {
        recurringSlots.push(new Date(d));
      }
    }

    // Create slots for each recurring date
    for (let i = 0; i < recurringSlots.length; i++) {
      const slotDate = recurringSlots[i];
      const slotId = `${slot.id}_${i}`;
      
      const payload = {
        id: slotId,
        date: slotDate.toISOString().split('T')[0],
        fromTime: slot.fromTime,
        toTime: slot.toTime,
        fromPeriod: slot.fromPeriod,
        toPeriod: slot.toPeriod,
        teacherDocId,
        isRecurring: true,
        recurringType: slot.recurringType,
        originalSlotId: slot.id,
        recurringGroupId: `${slot.id}_${slot.recurringType}_${slot.recurringDays.join('_')}`
      };

      await addDoc(collection(db, 'teacherSlots'), payload);
    }

    // Update teacher's slot list
    await updateDoc(doc(db, 'Teacher', teacherDocId), {
      recurringSlots: arrayUnion({
        originalSlotId: slot.id,
        recurringType: slot.recurringType,
        recurringDays: slot.recurringDays,
        endDate: slot.endDate
      })
    });
  };

  const updateSlot = (slotId, field, value) => {
    setSlots(prev => prev.map(slot => 
      slot.id === slotId ? { ...slot, [field]: value } : slot
    ));
  };

  const toggleRecurring = (slotId) => {
    setSlots(prev => prev.map(slot => 
      slot.id === slotId ? { ...slot, isRecurring: !slot.isRecurring } : slot
    ));
  };

  const updateRecurringDays = (slotId, day) => {
    setSlots(prev => prev.map(slot => {
      if (slot.id === slotId) {
        const days = slot.recurringDays.includes(day)
          ? slot.recurringDays.filter(d => d !== day)
          : [...slot.recurringDays, day];
        return { ...slot, recurringDays: days };
      }
      return slot;
    }));
  };

  const copySlot = (sourceSlotId, targetSlotId) => {
    const sourceSlot = slots.find(slot => slot.id === sourceSlotId);
    if (sourceSlot && sourceSlot.date && sourceSlot.fromTime && sourceSlot.toTime) {
      setSlots(prev =>
        prev.map(slot =>
          slot.id === targetSlotId
            ? {
              ...slot,
              date: sourceSlot.date,
              fromTime: sourceSlot.fromTime,
              toTime: sourceSlot.toTime,
              fromPeriod: sourceSlot.fromPeriod,
              toPeriod: sourceSlot.toPeriod
            }
            : slot
        )
      );
    }
  };
  const clearSlot = async (slotId) => {
  const clearedSlot = {
    id: slotId,
    date: '',
    fromTime: '',
    toTime: '',
    fromPeriod: 'AM',
    toPeriod: 'AM',
  };
  setSlots(prev =>
    prev.map(slot =>
      slot.id === slotId ? clearedSlot : slot
    )
  );
  try {
      if (!teacherDocId) return;
      // Find and delete the stored slot for this teacher and this UI slot id
      const snap = await getDocs(
        query(
          collection(db, 'teacherSlots'),
          where('teacherDocId', '==', teacherDocId),
          where('id', '==', slotId)
        )
      );
      if (!snap.empty) {
        const ref = snap.docs[0].ref;
        const slotAutoId = snap.docs[0].id;
        await deleteDoc(ref);
        // Remove from Teacher.mySlots
        await updateDoc(doc(db, 'Teacher', teacherDocId), {
          mySlots: arrayRemove(slotAutoId),
        });
      }
    } catch (error) {
    // Error clearing slot
  }
};
const generateTimeOptions = () => {
    const times = [];
    for (let hour = 1; hour <= 12; hour++) {
      for (let minute of ['00', '15', '30', '45']) {
        const timeStr = `${hour.toString().padStart(2, '0')}:${minute}`;
        times.push(timeStr);
      }
    }
    return times;
  };
  const timeOptions = generateTimeOptions();
  const isMobile = windowWidth <= 480;
  const isTablet = windowWidth > 480 && windowWidth <= 768;

  const daysOfWeek = [
    { key: 'monday', label: 'Mon' },
    { key: 'tuesday', label: 'Tue' },
    { key: 'wednesday', label: 'Wed' },
    { key: 'thursday', label: 'Thu' },
    { key: 'friday', label: 'Fri' },
    { key: 'saturday', label: 'Sat' },
    { key: 'sunday', label: 'Sun' }
  ];

  return (
    <div className={`booking-wrapper ${isMobile ? 'mobile' : isTablet ? 'tablet' : 'desktop'}`}>
      <div className="booking-card">
        <h2 className="booking-title">Teacher Availability Booking</h2>
        {slots.map((slot, index) => (
          <div key={slot.id} className="slot-card">
            <div className={`slot-header ${isTablet ? 'tablet' : ''}`}>
              <h3 className="slot-title">
                <Calendar size={20} />
                Slot {slot.id}
              </h3>
              <div className="slot-controls">
               
                {index > 0 && (
                  <select
                    onChange={(e) => e.target.value && copySlot(parseInt(e.target.value), slot.id)}
                    value=""
                    className="copy-select"
                  >
                    <option value="">Copy from...</option>
                    {slots.filter(s => s.id < slot.id && s.date).map(s => (
                      <option key={s.id} value={s.id}>
                        Slot {s.id} ({s.date})
                      </option>
                    ))}
                  </select>
                )}
                <button onClick={() => clearSlot(slot.id)} className="clear-btn">Clear</button>
              </div>
            </div>

            <div className="booking-form-group">
              <label>Select Date</label>
              <input
                type="date"
                value={slot.date}
                onChange={(e) => updateSlot(slot.id, 'date', e.target.value)}
                min={new Date().toISOString().split('T')[0]}
              />
            </div>

            {/* Recurring Options */}
            {slot.isRecurring && (
              <div className="recurring-options">
                <div className="recurring-type">
                  <label>Recurring Type:</label>
                  <select
                    value={slot.recurringType}
                    onChange={(e) => updateSlot(slot.id, 'recurringType', e.target.value)}
                  >
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>

                <div className="recurring-days">
                  <label>Repeat on:</label>
                  <div className="days-grid">
                    {daysOfWeek.map(day => (
                      <button
                        key={day.key}
                        type="button"
                        className={`day-btn ${slot.recurringDays.includes(day.key) ? 'selected' : ''}`}
                        onClick={() => updateRecurringDays(slot.id, day.key)}
                      >
                        {day.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="recurring-end">
                  <label>End Date:</label>
                  <input
                    type="date"
                    value={slot.endDate}
                    onChange={(e) => updateSlot(slot.id, 'endDate', e.target.value)}
                    min={slot.date || new Date().toISOString().split('T')[0]}
                  />
                </div>
              </div>
            )}

            {/* Time Layout */}
            <div className={`time-picker ${isMobile ? 'stacked' : isTablet ? 'tablet' : 'desktop'}`}>
              {['from', 'to'].map(type => (
                <div key={type} className="time-group">
                  <label>{type === 'from' ? 'From Time' : 'To Time'}</label>
                  <div className="time-row">
                    <select
                      value={slot[`${type}Time`]}
                      onChange={(e) => updateSlot(slot.id, `${type}Time`, e.target.value)}
                    >
                      <option value="">Select time</option>
                      {timeOptions.map(time => (
                        <option key={time} value={time}>{time}</option>
                      ))}
                    </select>
                    <select
                      value={slot[`${type}Period`]}
                      onChange={(e) => updateSlot(slot.id, `${type}Period`, e.target.value)}
                    >
                      <option value="AM">AM</option>
                      <option value="PM">PM</option>
                    </select>
                  </div>
                </div>
              ))}
            </div>

            {slot.date && slot.fromTime && slot.toTime && (
              <div className="slot-summary">
                <div className="slot-day">
                  <Clock size={16} />
                  {slot.isRecurring ? (
                    <span>
                      {slot.recurringDays.map(day => 
                        day.charAt(0).toUpperCase() + day.slice(1)
                      ).join(', ')} - {slot.recurringType}
                    </span>
                  ) : (
                    new Date(slot.date).toLocaleDateString('en-US', {
                    weekday: isMobile ? 'short' : 'long',
                    year: 'numeric',
                    month: isMobile ? 'short' : 'long',
                    day: 'numeric'
                    })
                  )}
                </div>
                <div className="slot-time">
                  {slot.fromTime} {slot.fromPeriod} - {slot.toTime} {slot.toPeriod}
                </div>
                {slot.isRecurring && slot.endDate && (
                  <div className="slot-end">
                    Until: {new Date(slot.endDate).toLocaleDateString()}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        <button className="submit-btn" onClick={handleSave}>
          Save Slot
        </button>
      </div>

      <style jsx>{`
        .recurring-options {
          background: #f8fafc;
          border-radius: 8px;
          padding: 16px;
          margin: 12px 0;
          border: 1px solid #e2e8f0;
        }
        .recurring-type, .recurring-days, .recurring-end {
          margin-bottom: 12px;
        }
        .recurring-type label, .recurring-days label, .recurring-end label {
          display: block;
          font-weight: 500;
          margin-bottom: 6px;
          color: #4a5568;
        }
        .days-grid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 4px;
        }
        .day-btn {
          padding: 6px 8px;
          border: 1px solid #d1d5db;
          background: white;
          border-radius: 4px;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.2s;
        }
        .day-btn.selected {
          background: #127d8e;
          color: white;
          border-color: #127d8e;
        }
      
      
        .slot-end {
          font-size: 12px;
          color: #6b7280;
          margin-top: 4px;
        }
      `}</style>
    </div>
  );
};

export default SlotBooking;