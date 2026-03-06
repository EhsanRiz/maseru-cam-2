import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../App'
import { supabase } from '../lib/supabase'
import { 
  LogOut, Search, Users, Home, ChevronRight, ChevronLeft,
  CreditCard, FileText, User, Printer, Edit2, 
  Save, Upload, MapPin, Camera, Check, XCircle, Building2, TreePine,
  Download, X, TrendingUp, Bell, CheckCircle, Clock, AlertCircle,
  Plus, Trash2, Eye, ScanLine, FileUp, ArrowRightLeft, RefreshCw
} from 'lucide-react'

// 4D Climate Solutions Color Scheme (Lipalo-inspired)
const colors = {
  primary: '#1a3a4a',
  primaryDark: '#0f2a36',
  accent: '#8cc63f',
  accentHover: '#7ab62f',
  success: '#22c55e',
  warning: '#f59e0b',
  error: '#ef4444',
  textDark: '#1f2937',
  textMuted: '#6b7280',
  textLight: '#9ca3af',
  bgLight: '#f8fafc',
  bgCard: '#ffffff',
  border: '#e2e8f0',
  rural: '#059669',
  urban: '#7c3aed',
}

// Occupation options
const OCCUPATION_OPTIONS = [
  'Working for remuneration, formally/informally',
  'Any form of self-employment',
  'Subsistence farming (Crop Farming, Livestock, Livestock rearing)',
  'School-going/Youngster',
  'Unemployed (18 years or older)',
  'Retired from formal employment',
  'Homemaker/Housewife',
  'Domestic responsibilities',
  'Herdboy',
  'Pensioner',
  'Old and no longer economically active',
]

// Map icon component
const MapIcon = ({ size = 24, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon>
    <line x1="8" y1="2" x2="8" y2="18"></line>
    <line x1="16" y1="6" x2="16" y2="22"></line>
  </svg>
)

export default function Dashboard() {
  const { user, logout } = useAuth()
  const [households, setHouseholds] = useState([])
  const [routes, setRoutes] = useState([])
  const [loading, setLoading] = useState(true)
  
  const [view, setView] = useState('routes')
  const [selectedRoute, setSelectedRoute] = useState(null)
  const [selectedHousehold, setSelectedHousehold] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  
  // Global search state
  const [globalSearchQuery, setGlobalSearchQuery] = useState('')
  const [globalSearchResults, setGlobalSearchResults] = useState([])
  const [showGlobalSearch, setShowGlobalSearch] = useState(false)
  
  const [activeTab, setActiveTab] = useState('details')
  const [editMode, setEditMode] = useState(false)
  const [editedData, setEditedData] = useState({})
  const [saving, setSaving] = useState(false)

  const isAdmin = user?.role === 'Admin' || user?.role === 'admin'
  const isMamokuena = user?.full_name?.toLowerCase().includes('mamokuena') || user?.username?.toLowerCase().includes('mamokuena')
  const canApprove = isAdmin || isMamokuena

  // Notifications state
  const [notifications, setNotifications] = useState([])
  const [showNotifications, setShowNotifications] = useState(false)
  const [pendingApprovals, setPendingApprovals] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)

  // Add PAP state
  const [showAddPAP, setShowAddPAP] = useState(false)
  const [newPAPData, setNewPAPData] = useState({})
  const [savingNewPAP, setSavingNewPAP] = useState(false)
  const [showCustomOccupationNew, setShowCustomOccupationNew] = useState(false)
  const [previewDoc, setPreviewDoc] = useState(null)

  // Build dynamic occupation options from existing data
  const occupationOptions = (() => {
    const existing = households.map(h => h.occupation_of_pap).filter(Boolean).map(o => o.trim())
    const unique = [...new Set(existing)].filter(o => !OCCUPATION_OPTIONS.includes(o) && o !== 'Other')
    return [...OCCUPATION_OPTIONS, ...unique.sort(), 'Other']
  })()

  useEffect(() => {
    loadData()
    loadNotifications()

    // Real-time subscriptions
    const ch1 = supabase.channel('households-changes').on('postgres_changes', { event: '*', schema: 'public', table: 'households' }, () => {
      loadData()
    }).subscribe()
    const ch2 = supabase.channel('edit-requests-changes').on('postgres_changes', { event: '*', schema: 'public', table: 'edit_requests' }, () => loadNotifications()).subscribe()
    const ch3 = supabase.channel('notifications-changes').on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, () => loadNotifications()).subscribe()

    return () => {
      supabase.removeChannel(ch1)
      supabase.removeChannel(ch2)
      supabase.removeChannel(ch3)
    }
  }, [])

  // Load notifications and pending approvals
  const loadNotifications = async () => {
    try {
      // Load notifications for current user
      let notifQuery = supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(20)
      if (canApprove) {
        notifQuery = notifQuery.or(`user_id.eq.${user?.id},user_role.eq.${user?.role},user_role.eq.Admin,user_role.eq.approver`)
      } else {
        notifQuery = notifQuery.or(`user_id.eq.${user?.id},user_role.eq.${user?.role}`)
      }
      const { data: notifData } = await notifQuery
      
      if (notifData) {
        setNotifications(notifData)
        setUnreadCount(notifData.filter(n => !n.is_read).length)
      }

      // Load pending approvals if user can approve
      if (canApprove) {
        const { data: pendingData } = await supabase
          .from('edit_requests')
          .select('*, households(household_head_first_name, household_head_surname, route_name)')
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
        
        if (pendingData) {
          setPendingApprovals(pendingData)
        }
      }

      // Check for approval notifications for regular users
      if (!canApprove) {
        const { data: myApprovals } = await supabase
          .from('edit_requests')
          .select('*')
          .eq('requested_by', user?.id)
          .eq('requester_notified', false)
          .in('status', ['approved', 'rejected'])
        
        if (myApprovals && myApprovals.length > 0) {
          // Mark as notified and show alert
          for (const approval of myApprovals) {
            await supabase
              .from('edit_requests')
              .update({ requester_notified: true })
              .eq('id', approval.id)
          }
          
          const approvedCount = myApprovals.filter(a => a.status === 'approved').length
          const rejectedCount = myApprovals.filter(a => a.status === 'rejected').length
          
          if (approvedCount > 0) {
            alert(`🎉 Good news! ${approvedCount} of your edit(s) have been approved!`)
          }
          if (rejectedCount > 0) {
            alert(`ℹ️ ${rejectedCount} of your edit(s) were not approved. Please check with your supervisor.`)
          }
        }
      }
    } catch (err) {
      console.error('Error loading notifications:', err)
    }
  }

  // Sync selectedHousehold when households data refreshes (e.g. after approval, document upload)
  useEffect(() => {
    if (selectedHousehold && households.length > 0) {
      const updated = households.find(h => h.id === selectedHousehold.id)
      if (updated) {
        setSelectedHousehold(updated)
        if (!editMode) setEditedData({ ...updated })
      }
    }
  }, [households])

  // Global search effect
  useEffect(() => {
    if (globalSearchQuery.length >= 2) {
      const search = globalSearchQuery.toLowerCase()
      const results = households.filter(h => 
        h.household_head_first_name?.toLowerCase().includes(search) ||
        h.household_head_surname?.toLowerCase().includes(search) ||
        h.id_number?.toLowerCase().includes(search) ||
        h.file_number?.toLowerCase().includes(search) ||
        h.route_name?.toLowerCase().includes(search)
      ).slice(0, 20) // Limit to 20 results
      setGlobalSearchResults(results)
    } else {
      setGlobalSearchResults([])
    }
  }, [globalSearchQuery, households])

  const loadData = async () => {
    try {
      setLoading(true)
      
      const { data: batch1, error: error1 } = await supabase
        .from('households')
        .select('*')
        .order('household_head_surname', { ascending: true })
        .range(0, 999)
      
      if (error1) throw error1
      
      const { data: batch2, error: error2 } = await supabase
        .from('households')
        .select('*')
        .order('household_head_surname', { ascending: true })
        .range(1000, 1999)
      
      if (error2) throw error2
      
      const householdData = [...(batch1 || []), ...(batch2 || [])]
      console.log('Total households loaded:', householdData.length)
      
      setHouseholds(householdData)
      
      const routeMap = new Map()
      householdData?.forEach(h => {
        const routeName = h.route_name
        if (routeName) {
          if (!routeMap.has(routeName)) {
            routeMap.set(routeName, {
              name: routeName,
              type: h.route_type || 'Unknown',
              pap_count: 0
            })
          }
          routeMap.get(routeName).pap_count++
        }
      })
      
      const sortedRoutes = Array.from(routeMap.values()).sort((a, b) => a.name.localeCompare(b.name))
      setRoutes(sortedRoutes)
      
    } catch (err) {
      console.error('Error loading data:', err)
    } finally {
      setLoading(false)
    }
  }

  const loadPAPDetails = async (pap) => {
    try {
      const { data, error } = await supabase
        .from('households')
        .select(`*, beneficiaries (*), banking_details (*), household_assets (*)`)
        .eq('id', pap.id)
        .single()
      if (error) throw error
      return data
    } catch (err) {
      console.error('Error loading PAP details:', err)
      return pap
    }
  }

  const stats = {
    total: households.length,
    routes: routes.length,
    verified: households.filter(h => h.verification_status?.toLowerCase() === 'verified' || h.approval_status === 'approved').length,
    withGPS: households.filter(h => h.latitude && h.longitude).length
  }

  // Progress calculation
  const progress = {
    verified: stats.verified,
    total: stats.total,
    percentage: stats.total > 0 ? Math.round((stats.verified / stats.total) * 100) : 0,
    withPhotos: households.filter(h => h.photograph_of_pap_url).length,
    withID: households.filter(h => h.id_number).length,
    withFileNo: households.filter(h => h.file_number).length,
  }

  const ruralRoutes = routes.filter(r => r.type === 'Rural')
  const urbanRoutes = routes.filter(r => r.type === 'Urban')

  const filteredPAPs = selectedRoute 
    ? households.filter(h => {
        if (h.route_name !== selectedRoute.name) return false
        if (!searchQuery) return true
        const search = searchQuery.toLowerCase()
        return (
          h.household_head_first_name?.toLowerCase().includes(search) ||
          h.household_head_surname?.toLowerCase().includes(search) ||
          h.id_number?.toLowerCase().includes(search) ||
          h.file_number?.toLowerCase().includes(search)
        )
      })
    : []

  const handleSelectRoute = (route) => {
    setSelectedRoute(route)
    setSearchQuery('')
    setView('paps')
  }

  const handleSelectPAP = async (h) => {
    const fullData = await loadPAPDetails(h)
    setSelectedHousehold(fullData)
    setEditedData({ ...fullData })
    setEditMode(false)
    setActiveTab('details')
    setView('detail')
    // Close global search if open
    setShowGlobalSearch(false)
    setGlobalSearchQuery('')
  }

  const handleBack = () => {
    if (view === 'detail') {
      setSelectedHousehold(null)
      setView('paps')
    } else if (view === 'paps') {
      setSelectedRoute(null)
      setView('routes')
    }
  }

  const handleFieldChange = (field, value) => {
    setEditedData(prev => ({ ...prev, [field]: value }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      // Get the changes made
      const changes = {}
      const editableFields = [
        'household_head_first_name', 'household_head_surname', 'gender',
        'id_number', 'cellphone_no', 'file_number', 'occupation_of_pap',
        'community_council', 'original_village', 'current_village', 'photograph_of_pap_url', 'id_document_url',
        'asset_photo_url', 'map_url', 'verification_status',
        'route_name', 'route_type', 'land_use', 'gps_coordinates', 'latitude', 'longitude',
        'affected_area_perm', 'affected_area_temp', 'rate_perm', 'rate_temp',
        'disturbance_allowance', 'total_compensation'
      ]
      
      editableFields.forEach(field => {
        if (editedData[field] !== selectedHousehold[field]) {
          changes[field] = {
            old: selectedHousehold[field],
            new: editedData[field]
          }
        }
      })

      // If user can approve (Admin or Mamokuena), save directly
      if (canApprove) {
        const { error } = await supabase
          .from('households')
          .update({
            household_head_first_name: editedData.household_head_first_name,
            household_head_surname: editedData.household_head_surname,
            gender: editedData.gender || null,
            id_number: editedData.id_number,
            cellphone_no: editedData.cellphone_no,
            file_number: editedData.file_number,
            occupation_of_pap: editedData.occupation_of_pap,
            community_council: editedData.community_council,
            original_village: editedData.original_village || null,
            current_village: editedData.current_village || null,
            photograph_of_pap_url: editedData.photograph_of_pap_url,
            id_document_url: editedData.id_document_url,
            asset_photo_url: editedData.asset_photo_url,
            map_url: editedData.map_url,
            verification_status: editedData.verification_status || 'pending',
            route_name: editedData.route_name,
            route_type: editedData.route_type,
            land_use: editedData.land_use || null,
            gps_coordinates: editedData.gps_coordinates || null,
            latitude: editedData.latitude || null,
            longitude: editedData.longitude || null,
            affected_area_perm: editedData.affected_area_perm || null,
            affected_area_temp: editedData.affected_area_temp || null,
            rate_perm: editedData.rate_perm || null,
            rate_temp: editedData.rate_temp || null,
            disturbance_allowance: editedData.disturbance_allowance || null,
            total_compensation: editedData.total_compensation || null,
            last_edited_by: user?.id,
            last_edited_by_name: user?.full_name,
            last_edited_at: new Date().toISOString(),
          })
          .eq('id', editedData.id)

        if (error) throw error

        await loadData()
        const updated = households.find(h => h.id === editedData.id)
        if (updated) setSelectedHousehold(updated)
        setEditMode(false)
        alert('✅ Changes saved successfully!')
      } else {
        // Regular user - submit for approval
        if (Object.keys(changes).length === 0) {
          alert('No changes detected.')
          setSaving(false)
          return
        }

        // Create edit request
        const { error: reqError } = await supabase
          .from('edit_requests')
          .insert({
            household_id: editedData.id,
            requested_by: user?.id,
            requested_by_name: user?.full_name,
            changes: changes,
            status: 'pending'
          })

        if (reqError) throw reqError

        // Create notification for approvers
        await supabase.from('notifications').insert([
          {
            user_role: 'Admin',
            type: 'edit_request',
            title: 'New Edit Request',
            message: `${user?.full_name} has submitted changes for ${editedData.household_head_first_name} ${editedData.household_head_surname}`,
            reference_type: 'household',
            reference_id: editedData.id
          }
        ])

        // Mark household as pending approval
        await supabase
          .from('households')
          .update({ pending_approval: true })
          .eq('id', editedData.id)

        await loadData()
        await loadNotifications()
        setEditMode(false)
        alert('📤 Your changes have been submitted for approval. You will be notified when approved.')
      }
    } catch (err) {
      console.error('Save error:', err)
      alert('Error saving: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  // Handle approval/rejection of edit requests
  const handleApproval = async (request, approved) => {
    try {
      if (approved) {
        // Check if this is a delete request
        if (request.changes?._action?.new === 'delete') {
          await supabase.from('households').delete().eq('id', request.household_id)
          await supabase.from('edit_requests').update({ status: 'approved', reviewed_by: user?.id, reviewed_by_name: user?.full_name, reviewed_at: new Date().toISOString() }).eq('id', request.id)
          await supabase.from('notifications').insert({ user_id: request.requested_by, type: 'approval', title: 'Delete Approved ✅', message: `Your delete request for ${request.households?.household_head_first_name} ${request.households?.household_head_surname} was approved by ${user?.full_name}`, reference_type: 'edit_request', reference_id: request.id })
          await loadData()
          await loadNotifications()
          setSelectedHousehold(null)
          alert('✅ PAP deleted.')
          return
        }

        // Apply the changes to household
        const updates = {}
        Object.keys(request.changes).forEach(field => {
          const val = request.changes[field].new
          updates[field] = (val === '' || val === undefined) ? null : val
        })
        updates.last_edited_by = request.requested_by
        updates.last_edited_by_name = request.requested_by_name
        updates.last_edited_at = new Date().toISOString()
        updates.pending_approval = false
        updates.verification_status = 'verified'

        const { error: updateError } = await supabase
          .from('households')
          .update(updates)
          .eq('id', request.household_id)

        if (updateError) throw updateError
      } else {
        // Just clear pending flag
        await supabase
          .from('households')
          .update({ pending_approval: false })
          .eq('id', request.household_id)
      }

      // Update the request status
      await supabase
        .from('edit_requests')
        .update({
          status: approved ? 'approved' : 'rejected',
          reviewed_by: user?.id,
          reviewed_by_name: user?.full_name,
          reviewed_at: new Date().toISOString()
        })
        .eq('id', request.id)

      // Create notification for the requester
      await supabase.from('notifications').insert({
        user_id: request.requested_by,
        type: approved ? 'approval' : 'rejection',
        title: approved ? 'Edit Approved ✅' : 'Edit Not Approved',
        message: `Your changes for ${request.households?.household_head_first_name} ${request.households?.household_head_surname} have been ${approved ? 'approved' : 'rejected'} by ${user?.full_name}`,
        reference_type: 'edit_request',
        reference_id: request.id
      })

      await loadData()
      await loadNotifications()
      // Refresh selected household if viewing the approved PAP
      if (selectedHousehold?.id === request.household_id) {
        const { data: refreshed } = await supabase.from('households').select('*').eq('id', request.household_id).single()
        if (refreshed) { setSelectedHousehold(refreshed); setEditedData({ ...refreshed }) }
      }
      alert(approved ? '✅ Changes approved and applied!' : '❌ Request rejected')
    } catch (err) {
      console.error('Approval error:', err)
      alert('Error: ' + err.message)
    }
  }

  // Mark notification as read
  const markNotificationRead = async (notifId) => {
    await supabase.from('notifications').update({ is_read: true }).eq('id', notifId)
    loadNotifications()
  }

  // Compress image before upload (max 1200px, 80% quality)
  const compressImage = (file) => {
    return new Promise((resolve) => {
      if (!file.type.startsWith('image/')) return resolve(file)
      const img = new Image()
      img.onload = () => {
        const MAX = 1200
        let w = img.width, h = img.height
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX }
          else { w = Math.round(w * MAX / h); h = MAX }
        }
        const canvas = document.createElement('canvas')
        canvas.width = w; canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        canvas.toBlob((blob) => {
          resolve(new File([blob], file.name, { type: 'image/jpeg' }))
        }, 'image/jpeg', 0.8)
      }
      img.onerror = () => resolve(file)
      img.src = URL.createObjectURL(file)
    })
  }

  // Upload file to R2 via API
  const uploadToR2 = async (file, category) => {
    const pap = selectedHousehold
    const compressed = await compressImage(file)
    const formData = new FormData()
    formData.append('file', compressed)
    formData.append('routeName', pap?.route_name || 'unknown')
    formData.append('papName', `${pap?.household_head_first_name || ''}_${pap?.household_head_surname || ''}`.trim() || 'unknown')
    formData.append('category', category)

    const resp = await fetch('/api/upload', { method: 'POST', body: formData })
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}))
      throw new Error(err.error || 'Upload failed')
    }
    return resp.json()
  }

  const handlePhotoUpload = async (field, file) => {
    if (!file) return
    try {
      const result = await uploadToR2(file, 'photos')

      await supabase.from('households').update({ [field]: result.url }).eq('id', selectedHousehold.id)

      setEditedData(prev => ({ ...prev, [field]: result.url }))
      setSelectedHousehold(prev => ({ ...prev, [field]: result.url }))
      alert('Photo uploaded!')
    } catch (err) {
      console.error('Upload error:', err)
      alert('Upload error: ' + err.message)
    }
  }

  // Handle document file upload
  const handleDocumentUpload = async (file, docName) => {
    if (!file || !selectedHousehold) return
    try {
      const result = await uploadToR2(file, 'documents')

      const fileExt = file.name.split('.').pop()
      // Always read current docs from DB to avoid race condition with sequential uploads
      const { data: current } = await supabase.from('households').select('other_documents').eq('id', selectedHousehold.id).single()
      const existing = current?.other_documents || []
      const newDoc = { name: docName || file.name, url: result.url, key: result.key, uploaded_at: new Date().toISOString(), file_type: fileExt.toLowerCase() }
      const updated = [...existing, newDoc]

      await supabase.from('households').update({ other_documents: updated }).eq('id', selectedHousehold.id)
      setSelectedHousehold(prev => ({ ...prev, other_documents: updated }))
      setEditedData(prev => ({ ...prev, other_documents: updated }))
      return true
    } catch (err) {
      console.error('Upload error:', err)
      throw err
    }
  }

  // Delete a document
  const handleDeleteDocument = async (index) => {
    if (!selectedHousehold) return
    if (!confirm('Delete this document?')) return
    try {
      const existing = selectedHousehold.other_documents || []
      const doc = existing[index]
      // Delete from R2 if we have the key
      if (doc?.key) {
        await fetch('/api/delete', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: doc.key }) }).catch(() => {})
      }
      const updated = existing.filter((_, i) => i !== index)
      await supabase.from('households').update({ other_documents: updated }).eq('id', selectedHousehold.id)
      setSelectedHousehold(prev => ({ ...prev, other_documents: updated }))
      setEditedData(prev => ({ ...prev, other_documents: updated }))
      alert('Document deleted.')
    } catch (err) {
      console.error('Delete error:', err)
      alert('Error: ' + err.message)
    }
  }

  // Upload CAF (single file, replaces existing)
  const handleCAFUpload = async (file) => {
    try {
      const oldCAF = selectedHousehold.caf_document
      if (oldCAF?.key) {
        await fetch('/api/delete', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: oldCAF.key }) }).catch(() => {})
      }
      const result = await uploadToR2(file, 'caf')
      const fileExt = file.name.split('.').pop() || 'pdf'
      const cafDoc = { name: file.name, url: result.url, key: result.key, uploaded_at: new Date().toISOString(), file_type: fileExt.toLowerCase(), size: file.size }
      await supabase.from('households').update({ caf_document: cafDoc }).eq('id', selectedHousehold.id)
      setSelectedHousehold(prev => ({ ...prev, caf_document: cafDoc }))
      setEditedData(prev => ({ ...prev, caf_document: cafDoc }))
      alert('✅ CAF uploaded successfully!')
    } catch (err) {
      console.error('CAF upload error:', err)
      alert('CAF upload failed: ' + err.message)
    }
  }

  // Delete CAF
  const handleDeleteCAF = async () => {
    if (!confirm('Delete the Compensation Agreement Form?')) return
    try {
      const caf = selectedHousehold.caf_document
      if (caf?.key) {
        await fetch('/api/delete', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: caf.key }) }).catch(() => {})
      }
      await supabase.from('households').update({ caf_document: null }).eq('id', selectedHousehold.id)
      setSelectedHousehold(prev => ({ ...prev, caf_document: null }))
      setEditedData(prev => ({ ...prev, caf_document: null }))
      alert('CAF deleted.')
    } catch (err) {
      console.error('CAF delete error:', err)
      alert('Delete failed: ' + err.message)
    }
  }

  // Delete PAP
  const handleDeletePAP = async (pap) => {
    if (canApprove) {
      if (!confirm(`⚠️ Permanently delete ${pap.household_head_first_name} ${pap.household_head_surname}?\n\nThis cannot be undone.`)) return
      try {
        await supabase.from('households').delete().eq('id', pap.id)
        await loadData()
        setSelectedHousehold(null)
        setView('paps')
        alert('🗑️ PAP deleted.')
      } catch (err) {
        console.error('Delete error:', err)
        alert('Error: ' + err.message)
      }
    } else {
      if (!confirm(`Request to delete ${pap.household_head_first_name} ${pap.household_head_surname}?\n\nThis will be sent for approval.`)) return
      try {
        await supabase.from('edit_requests').insert({
          household_id: pap.id,
          requested_by: user?.id,
          requested_by_name: user?.full_name,
          changes: { _action: { old: 'active', new: 'delete' } },
          status: 'pending'
        })
        await supabase.from('notifications').insert({
          user_role: 'Admin',
          type: 'edit_request',
          title: '🗑️ Delete Request',
          message: `${user?.full_name} requested to delete ${pap.household_head_first_name} ${pap.household_head_surname}`,
          reference_type: 'household',
          reference_id: pap.id
        })
        await supabase.from('households').update({ pending_approval: true }).eq('id', pap.id)
        await loadData()
        await loadNotifications()
        alert('📤 Delete request submitted for approval.')
      } catch (err) {
        console.error('Error:', err)
        alert('Error: ' + err.message)
      }
    }
  }

  // Start adding a new PAP
  const handleStartAddPAP = () => {
    setNewPAPData({
      household_head_first_name: '', household_head_surname: '', gender: '', id_number: '',
      cellphone_no: '', file_number: '', occupation_of_pap: '', community_council: '', original_village: '', current_village: '',
      land_use: 'Res', route_name: selectedRoute?.name || '', route_type: selectedRoute?.type || '',
      gps_coordinates: '', latitude: '', longitude: '',
      affected_area_perm: '', affected_area_temp: '', rate_perm: '', rate_temp: '',
      disturbance_allowance: '', total_compensation: '', verification_status: 'pending', other_documents: []
    })
    setShowAddPAP(true)
  }

  // Save new PAP
  const handleSaveNewPAP = async () => {
    if (!newPAPData.household_head_first_name || !newPAPData.household_head_surname) {
      alert('Please enter at least First Name and Surname.')
      return
    }
    setSavingNewPAP(true)
    try {
      const record = { ...newPAPData }
      // Convert empty strings to null (avoid check constraint violations)
      Object.keys(record).forEach(k => { if (record[k] === '') record[k] = null })
      const numericFields = ['affected_area_perm', 'affected_area_temp', 'rate_perm', 'rate_temp', 'disturbance_allowance', 'total_compensation', 'latitude', 'longitude']
      numericFields.forEach(f => { record[f] = record[f] === '' || record[f] == null ? null : (parseFloat(record[f]) || null) })

      const { data: inserted, error } = await supabase.from('households').insert(record).select().single()
      if (error) throw error

      await loadData()
      setShowAddPAP(false)
      setNewPAPData({})
      if (inserted) { setSelectedHousehold(inserted); setEditedData({ ...inserted }); setView('detail'); setActiveTab('details') }
      alert('✅ New PAP added successfully!')
    } catch (err) {
      console.error('Error adding PAP:', err)
      alert('Error adding PAP: ' + err.message)
    } finally { setSavingNewPAP(false) }
  }

  // Export to Excel function
  const handleExportExcel = () => {
    // Prepare data for export
    const exportData = households.map(h => ({
      'First Name': h.household_head_first_name || '',
      'Surname': h.household_head_surname || '',
      'Route': h.route_name || '',
      'Route Type': h.route_type || '',
      'Land Use': h.land_use || '',
      'File Number': h.file_number || '',
      'ID Number': h.id_number || '',
      'Phone': h.cellphone_no || '',
      'Gender': h.gender || '',
      'Occupation': h.occupation_of_pap || '',
      'Original Village': h.original_village || '',
      'Current Village': h.current_village || '',
      'Permanent Area (sqm)': h.affected_area_perm || '',
      'Temporary Area (sqm)': h.affected_area_temp || '',
      'Disturbance Allowance (M)': h.disturbance_allowance || '',
      'Total Compensation (M)': h.total_compensation || '',
      'Latitude': h.latitude || '',
      'Longitude': h.longitude || '',
      'Verification Status': h.verification_status || 'pending',
      'Has Photo': h.photograph_of_pap_url ? 'Yes' : 'No',
      'Has ID Doc': h.id_document_url ? 'Yes' : 'No',
    }))

    // Convert to CSV
    const headers = Object.keys(exportData[0])
    const csvContent = [
      headers.join(','),
      ...exportData.map(row => 
        headers.map(header => {
          let cell = row[header]
          // Escape commas and quotes
          if (typeof cell === 'string' && (cell.includes(',') || cell.includes('"'))) {
            cell = `"${cell.replace(/"/g, '""')}"`
          }
          return cell
        }).join(',')
      )
    ].join('\n')

    // Download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    const url = URL.createObjectURL(blob)
    link.setAttribute('href', url)
    link.setAttribute('download', `CIMS_PAP_Export_${new Date().toISOString().split('T')[0]}.csv`)
    link.style.visibility = 'hidden'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const handlePrint = () => {
    const data = editedData.id ? editedData : selectedHousehold
    const printWindow = window.open('', '_blank')
    printWindow.document.write(generatePrintHTML(data))
    printWindow.document.close()
    setTimeout(() => printWindow.print(), 500)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: colors.bgLight }}>
      {/* Header */}
      <header style={{ 
        background: `linear-gradient(135deg, ${colors.primary} 0%, ${colors.primaryDark} 100%)`,
        padding: '0 20px', 
        flexShrink: 0, 
        zIndex: 100,
        boxShadow: '0 2px 10px rgba(0,0,0,0.1)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '60px', maxWidth: '1400px', margin: '0 auto', width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            {view !== 'routes' && (
              <button onClick={handleBack} style={{ 
                display: 'flex', alignItems: 'center', gap: '4px', padding: '8px 14px', 
                backgroundColor: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', 
                borderRadius: '8px', color: 'white', cursor: 'pointer', fontSize: '13px', fontWeight: '500',
                transition: 'all 0.2s'
              }}
              onMouseOver={e => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.2)'}
              onMouseOut={e => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.1)'}>
                <ChevronLeft size={18} /> Back
              </button>
            )}
            <div style={{ 
              width: '40px', height: '40px', 
              backgroundColor: colors.accent, 
              borderRadius: '10px', 
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(140, 198, 63, 0.3)'
            }}>
              <img src="/logo-llwdp.png" alt="CIMS" style={{ width: '30px', height: '30px', objectFit: 'contain' }} onError={(e) => { e.target.style.display = 'none' }} />
            </div>
            <div>
              <h1 style={{ color: 'white', fontSize: '18px', fontWeight: '700', margin: 0, letterSpacing: '-0.5px' }}>CIMS</h1>
              <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: '11px', margin: 0 }}>Asset Registration & Verification</p>
            </div>
            {selectedRoute && view !== 'routes' && (
              <div style={{ marginLeft: '8px', padding: '6px 14px', backgroundColor: colors.accent, borderRadius: '6px' }}>
                <span style={{ color: colors.primaryDark, fontSize: '13px', fontWeight: '600' }}>{selectedRoute.name}</span>
              </div>
            )}
          </div>
          
          {/* Global Search in Header */}
          <div style={{ flex: 1, maxWidth: '400px', margin: '0 20px', position: 'relative' }}>
            <Search size={18} style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.5)' }} />
            <input
              type="text"
              placeholder="Search all PAPs..."
              value={globalSearchQuery}
              onChange={(e) => { setGlobalSearchQuery(e.target.value); setShowGlobalSearch(true) }}
              onFocus={() => setShowGlobalSearch(true)}
              style={{ 
                width: '100%', padding: '10px 14px 10px 44px', 
                backgroundColor: 'rgba(255,255,255,0.1)', 
                border: '1px solid rgba(255,255,255,0.2)', 
                borderRadius: '10px', fontSize: '14px', color: 'white', outline: 'none', boxSizing: 'border-box',
                transition: 'all 0.2s'
              }}
            />
            {globalSearchQuery && (
              <button onClick={() => { setGlobalSearchQuery(''); setShowGlobalSearch(false) }} 
                style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px' }}>
                <X size={16} color="rgba(255,255,255,0.7)" />
              </button>
            )}
            
            {/* Global Search Results Dropdown */}
            {showGlobalSearch && globalSearchResults.length > 0 && (
              <div style={{ 
                position: 'absolute', top: '100%', left: 0, right: 0, marginTop: '8px',
                backgroundColor: colors.bgCard, borderRadius: '12px', 
                boxShadow: '0 10px 40px rgba(0,0,0,0.2)', border: `1px solid ${colors.border}`,
                maxHeight: '400px', overflowY: 'auto', zIndex: 1000
              }}>
                <div style={{ padding: '10px 14px', borderBottom: `1px solid ${colors.border}`, backgroundColor: colors.bgLight }}>
                  <span style={{ fontSize: '12px', fontWeight: '600', color: colors.textMuted }}>
                    {globalSearchResults.length} results found
                  </span>
                </div>
                {globalSearchResults.map(pap => (
                  <div key={pap.id} onClick={() => handleSelectPAP(pap)}
                    style={{ padding: '12px 14px', cursor: 'pointer', borderBottom: `1px solid ${colors.border}`, transition: 'background-color 0.15s' }}
                    onMouseOver={e => e.currentTarget.style.backgroundColor = colors.bgLight}
                    onMouseOut={e => e.currentTarget.style.backgroundColor = colors.bgCard}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div style={{ 
                        width: '36px', height: '36px', borderRadius: '8px', 
                        backgroundColor: `${colors.primary}15`, color: colors.primary,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', 
                        fontSize: '12px', fontWeight: '700' 
                      }}>
                        {pap.household_head_first_name?.[0]}{pap.household_head_surname?.[0]}
                      </div>
                      <div style={{ flex: 1 }}>
                        <p style={{ margin: 0, fontWeight: '600', color: colors.textDark, fontSize: '14px' }}>
                          {pap.household_head_first_name} {pap.household_head_surname}
                        </p>
                        <p style={{ margin: '2px 0 0 0', fontSize: '12px', color: colors.textMuted }}>
                          {pap.route_name} • {pap.land_use || 'N/A'}
                        </p>
                      </div>
                      <ChevronRight size={16} color={colors.textLight} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {/* Notification Bell */}
            <div style={{ position: 'relative' }}>
              <button onClick={() => setShowNotifications(!showNotifications)} 
                style={{ 
                  padding: '8px', backgroundColor: 'rgba(255,255,255,0.1)', 
                  border: 'none', borderRadius: '8px', color: 'rgba(255,255,255,0.8)', 
                  cursor: 'pointer', transition: 'all 0.2s', position: 'relative'
                }}
                onMouseOver={e => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.2)'}
                onMouseOut={e => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.1)'}>
                <Bell size={18} />
                {(unreadCount > 0 || pendingApprovals.length > 0) && (
                  <span style={{ 
                    position: 'absolute', top: '-4px', right: '-4px',
                    backgroundColor: colors.error, color: 'white',
                    fontSize: '10px', fontWeight: '700',
                    minWidth: '18px', height: '18px',
                    borderRadius: '9px', display: 'flex',
                    alignItems: 'center', justifyContent: 'center'
                  }}>
                    {unreadCount + pendingApprovals.length}
                  </span>
                )}
              </button>
              
              {/* Notifications Dropdown */}
              {showNotifications && (
                <div style={{ 
                  position: 'absolute', top: '100%', right: 0, marginTop: '8px',
                  width: '360px', backgroundColor: colors.bgCard, 
                  borderRadius: '12px', boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
                  border: `1px solid ${colors.border}`, zIndex: 1000,
                  maxHeight: '500px', overflowY: 'auto'
                }}>
                  <div style={{ 
                    padding: '14px 16px', borderBottom: `1px solid ${colors.border}`,
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                  }}>
                    <span style={{ fontWeight: '700', color: colors.textDark }}>Notifications</span>
                    <button onClick={() => setShowNotifications(false)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                      <X size={18} color={colors.textMuted} />
                    </button>
                  </div>
                  
                  {/* Pending Approvals for Admins */}
                  {canApprove && pendingApprovals.length > 0 && (
                    <div style={{ borderBottom: `1px solid ${colors.border}` }}>
                      <div style={{ padding: '10px 16px', backgroundColor: `${colors.warning}15` }}>
                        <span style={{ fontSize: '12px', fontWeight: '700', color: colors.warning }}>
                          ⏳ PENDING APPROVALS ({pendingApprovals.length})
                        </span>
                      </div>
                      {pendingApprovals.slice(0, 5).map(req => (
                        <div key={req.id} style={{ 
                          padding: '12px 16px', borderBottom: `1px solid ${colors.border}`,
                          backgroundColor: colors.bgLight
                        }}>
                          <p style={{ margin: 0, fontSize: '13px', fontWeight: '600', color: colors.textDark }}>
                            {req.households?.household_head_first_name} {req.households?.household_head_surname}
                          </p>
                          <p style={{ margin: '4px 0 8px 0', fontSize: '12px', color: colors.textMuted }}>
                            {req.changes?._action?.new === 'delete' ? '🗑️ DELETE REQUEST' : 'Edited'} by {req.requested_by_name} • {req.households?.route_name}
                          </p>
                          {req.changes && Object.keys(req.changes).length > 0 && (
                            <div style={{ backgroundColor: colors.bgCard, borderRadius: '8px', padding: '8px 10px', marginBottom: '10px', border: `1px solid ${colors.border}`, fontSize: '12px' }}>
                              {Object.entries(req.changes).map(([field, vals]) => (
                                <div key={field} style={{ display: 'flex', gap: '6px', padding: '4px 0', borderBottom: `1px solid ${colors.border}22`, alignItems: 'baseline' }}>
                                  <span style={{ fontWeight: '600', color: colors.textMuted, minWidth: '90px', flexShrink: 0 }}>{field.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}:</span>
                                  <span style={{ color: colors.error, textDecoration: 'line-through', opacity: 0.7 }}>{vals.old || '(empty)'}</span>
                                  <span style={{ color: colors.textMuted }}>→</span>
                                  <span style={{ color: colors.success, fontWeight: '600' }}>{vals.new || '(empty)'}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button onClick={() => handleApproval(req, true)} style={{ 
                              flex: 1, padding: '6px 12px', backgroundColor: colors.success, 
                              color: 'white', border: 'none', borderRadius: '6px', 
                              fontSize: '12px', fontWeight: '600', cursor: 'pointer'
                            }}>
                              ✓ Approve
                            </button>
                            <button onClick={() => handleApproval(req, false)} style={{ 
                              flex: 1, padding: '6px 12px', backgroundColor: colors.error, 
                              color: 'white', border: 'none', borderRadius: '6px',
                              fontSize: '12px', fontWeight: '600', cursor: 'pointer'
                            }}>
                              ✕ Reject
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  
                  {/* Regular Notifications */}
                  {notifications.length > 0 ? (
                    notifications.slice(0, 10).map(notif => (
                      <div key={notif.id} onClick={() => markNotificationRead(notif.id)}
                        style={{ 
                          padding: '12px 16px', borderBottom: `1px solid ${colors.border}`,
                          backgroundColor: notif.is_read ? colors.bgCard : `${colors.accent}10`,
                          cursor: 'pointer'
                        }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                          <div style={{ 
                            padding: '6px', borderRadius: '8px',
                            backgroundColor: notif.type === 'approval' ? `${colors.success}20` : 
                              notif.type === 'rejection' ? `${colors.error}20` : `${colors.warning}20`
                          }}>
                            {notif.type === 'approval' ? <CheckCircle size={16} color={colors.success} /> :
                             notif.type === 'rejection' ? <XCircle size={16} color={colors.error} /> :
                             <Clock size={16} color={colors.warning} />}
                          </div>
                          <div style={{ flex: 1 }}>
                            <p style={{ margin: 0, fontSize: '13px', fontWeight: '600', color: colors.textDark }}>
                              {notif.title}
                            </p>
                            <p style={{ margin: '2px 0 0 0', fontSize: '12px', color: colors.textMuted }}>
                              {notif.message}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))
                  ) : (
                    !canApprove || pendingApprovals.length === 0 ? (
                      <div style={{ padding: '30px', textAlign: 'center', color: colors.textMuted }}>
                        <Bell size={32} style={{ opacity: 0.3 }} />
                        <p style={{ marginTop: '8px', fontSize: '13px' }}>No notifications</p>
                      </div>
                    ) : null
                  )}
                </div>
              )}
            </div>
            
            <div style={{ 
              width: '38px', height: '38px', borderRadius: '50%', 
              background: `linear-gradient(135deg, ${colors.accent} 0%, ${colors.accentHover} 100%)`,
              color: colors.primaryDark, 
              display: 'flex', alignItems: 'center', justifyContent: 'center', 
              fontSize: '14px', fontWeight: '700',
              boxShadow: '0 2px 8px rgba(140, 198, 63, 0.3)'
            }}>
              {user?.full_name?.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || 'U'}
            </div>
            <div className="user-info" style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ color: 'white', fontSize: '14px', fontWeight: '500' }}>{user?.full_name}</span>
              <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '11px' }}>{user?.role}{canApprove ? ' • Can Approve' : ''}</span>
            </div>
            <button onClick={() => { logout(); window.location.hash = '#/login' }} 
              style={{ padding: '8px', backgroundColor: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '8px', color: 'rgba(255,255,255,0.8)', cursor: 'pointer', transition: 'all 0.2s' }}
              onMouseOver={e => e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.3)'}
              onMouseOut={e => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.1)'}>
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </header>

      {/* Click outside to close global search */}
      {showGlobalSearch && (
        <div onClick={() => setShowGlobalSearch(false)} style={{ position: 'fixed', inset: 0, zIndex: 50 }} />
      )}

      {/* Main Content */}
      <main style={{ flex: 1, overflow: 'auto', padding: '24px' }}>
        <div style={{ maxWidth: '1300px', margin: '0 auto' }}>
          
          {/* ROUTES VIEW */}
          {view === 'routes' && (
            <>
              {/* Progress Tracker */}
              <div style={{ 
                backgroundColor: colors.bgCard, 
                borderRadius: '16px', 
                padding: '20px 24px', 
                marginBottom: '20px',
                border: `1px solid ${colors.border}`,
                boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ padding: '8px', backgroundColor: `${colors.accent}15`, borderRadius: '8px' }}>
                      <TrendingUp size={20} color={colors.accent} />
                    </div>
                    <div>
                      <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700', color: colors.textDark }}>Verification Progress</h3>
                      <p style={{ margin: '2px 0 0 0', fontSize: '13px', color: colors.textMuted }}>
                        {progress.verified} of {progress.total} PAPs verified ({progress.percentage}%)
                      </p>
                    </div>
                  </div>
                  
                  {/* Export Button */}
                  <button onClick={handleExportExcel} style={{ 
                    display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 18px', 
                    backgroundColor: colors.primary, color: 'white', 
                    border: 'none', borderRadius: '10px', fontSize: '14px', fontWeight: '600', cursor: 'pointer',
                    boxShadow: '0 2px 8px rgba(26, 58, 74, 0.2)', transition: 'all 0.2s'
                  }}
                  onMouseOver={e => e.currentTarget.style.transform = 'translateY(-1px)'}
                  onMouseOut={e => e.currentTarget.style.transform = 'none'}>
                    <Download size={18} /> Export to Excel
                  </button>
                </div>
                
                {/* Progress Bar */}
                <div style={{ backgroundColor: colors.bgLight, borderRadius: '10px', height: '12px', overflow: 'hidden' }}>
                  <div style={{ 
                    width: `${progress.percentage}%`, 
                    height: '100%', 
                    background: `linear-gradient(90deg, ${colors.accent} 0%, ${colors.success} 100%)`,
                    borderRadius: '10px',
                    transition: 'width 0.5s ease'
                  }} />
                </div>
                
                {/* Progress Stats */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '16px', marginTop: '16px' }}>
                  <ProgressStat label="Verified" value={progress.verified} total={progress.total} color={colors.success} />
                  <ProgressStat label="With Photos" value={progress.withPhotos} total={progress.total} color={colors.primary} />
                  <ProgressStat label="With ID Number" value={progress.withID} total={progress.total} color={colors.warning} />
                  <ProgressStat label="With File No." value={progress.withFileNo} total={progress.total} color={colors.urban} />
                </div>
              </div>

              {/* Stats Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '24px' }}>
                <StatCard label="Total PAPs" value={stats.total} color={colors.primary} icon={Users} />
                <StatCard label="Routes" value={stats.routes} color={colors.accent} iconComponent={MapIcon} />
                <StatCard label="Verified" value={stats.verified} color={colors.success} icon={Check} />
                <StatCard label="With GPS" value={stats.withGPS} color={colors.warning} icon={MapPin} />
              </div>

              {/* Routes Card */}
              <div style={{ 
                backgroundColor: colors.bgCard, 
                borderRadius: '16px', 
                padding: '24px', 
                border: `1px solid ${colors.border}`,
                boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
              }}>
                <h2 style={{ 
                  fontSize: '18px', fontWeight: '700', color: colors.textDark, 
                  margin: '0 0 20px 0', display: 'flex', alignItems: 'center', gap: '10px' 
                }}>
                  <div style={{ padding: '8px', backgroundColor: `${colors.primary}10`, borderRadius: '8px' }}>
                    <MapIcon size={22} color={colors.primary} />
                  </div>
                  Select a Route
                </h2>

                {loading ? (
                  <div style={{ padding: '60px', textAlign: 'center' }}>
                    <div style={{ 
                      width: '44px', height: '44px', 
                      border: `3px solid ${colors.border}`, borderTopColor: colors.accent, 
                      borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' 
                    }} />
                    <p style={{ color: colors.textMuted, marginTop: '16px', fontSize: '14px' }}>Loading routes...</p>
                  </div>
                ) : routes.length === 0 ? (
                  <div style={{ padding: '60px', textAlign: 'center', color: colors.textMuted }}>
                    <MapIcon size={48} color={colors.border} />
                    <p style={{ marginTop: '12px' }}>No routes found. Please import data first.</p>
                    <button onClick={loadData} style={{ 
                      marginTop: '16px', padding: '10px 20px', 
                      backgroundColor: colors.accent, color: colors.primaryDark, 
                      border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: '600'
                    }}>
                      Reload Data
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Rural Routes */}
                    {ruralRoutes.length > 0 && (
                      <div style={{ marginBottom: '28px' }}>
                        <h3 style={{ 
                          fontSize: '13px', fontWeight: '700', color: colors.rural, 
                          margin: '0 0 14px 0', display: 'flex', alignItems: 'center', gap: '8px',
                          textTransform: 'uppercase', letterSpacing: '0.5px'
                        }}>
                          <TreePine size={18} /> Rural Routes ({ruralRoutes.length})
                        </h3>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '12px' }}>
                          {ruralRoutes.map(route => (
                            <RouteCard key={route.name} route={route} onClick={() => handleSelectRoute(route)} type="rural" households={households} />
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Urban Routes */}
                    {urbanRoutes.length > 0 && (
                      <div>
                        <h3 style={{ 
                          fontSize: '13px', fontWeight: '700', color: colors.urban, 
                          margin: '0 0 14px 0', display: 'flex', alignItems: 'center', gap: '8px',
                          textTransform: 'uppercase', letterSpacing: '0.5px'
                        }}>
                          <Building2 size={18} /> Urban Routes ({urbanRoutes.length})
                        </h3>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '12px' }}>
                          {urbanRoutes.map(route => (
                            <RouteCard key={route.name} route={route} onClick={() => handleSelectRoute(route)} type="urban" households={households} />
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          {/* PAPS LIST VIEW */}
          {view === 'paps' && selectedRoute && (
            <div style={{ 
              backgroundColor: colors.bgCard, 
              borderRadius: '16px', 
              border: `1px solid ${colors.border}`, 
              overflow: 'hidden',
              boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
            }}>
              <div style={{ 
                padding: '20px 24px', 
                borderBottom: `1px solid ${colors.border}`, 
                background: `linear-gradient(135deg, ${colors.bgLight} 0%, ${colors.bgCard} 100%)`
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' }}>
                  <div>
                    <h2 style={{ fontSize: '20px', fontWeight: '700', color: colors.textDark, margin: 0 }}>{selectedRoute.name}</h2>
                    <p style={{ fontSize: '14px', color: colors.textMuted, margin: '4px 0 0 0' }}>
                      <span style={{ 
                        color: selectedRoute.type === 'Rural' ? colors.rural : colors.urban, 
                        fontWeight: '600' 
                      }}>{selectedRoute.type}</span> • {filteredPAPs.length} PAPs
                    </p>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <button onClick={handleStartAddPAP} style={{
                      display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 16px',
                      backgroundColor: colors.accent, color: 'white', border: 'none',
                      borderRadius: '10px', fontSize: '13px', fontWeight: '700', cursor: 'pointer',
                      boxShadow: '0 2px 8px rgba(140, 198, 63, 0.3)'
                    }}>
                      <Plus size={16} /> Add PAP
                    </button>
                    <div style={{ position: 'relative', width: '220px' }}>
                    <Search size={18} style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', color: colors.textLight }} />
                    <input
                      type="text"
                      placeholder="Search PAPs in this route..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      style={{ 
                        width: '100%', padding: '12px 14px 12px 44px', 
                        backgroundColor: colors.bgCard, 
                        border: `1px solid ${colors.border}`, 
                        borderRadius: '10px', fontSize: '14px', outline: 'none', boxSizing: 'border-box',
                        transition: 'border-color 0.2s'
                      }}
                      onFocus={e => e.target.style.borderColor = colors.accent}
                      onBlur={e => e.target.style.borderColor = colors.border}
                    />
                  </div>
                  </div>
                </div>
              </div>

              <div style={{ maxHeight: '65vh', overflowY: 'auto' }}>
                {filteredPAPs.length === 0 ? (
                  <div style={{ padding: '60px', textAlign: 'center', color: colors.textMuted }}>
                    <Users size={48} style={{ opacity: 0.3 }} />
                    <p style={{ marginTop: '12px' }}>No PAPs found</p>
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ backgroundColor: colors.bgLight }}>
                        {['PAP Name', 'File No.', 'Land Use', 'GPS', 'Status', ''].map((header, i) => (
                          <th key={i} style={{ 
                            padding: '14px 20px', textAlign: i === 5 ? 'right' : 'left', 
                            fontSize: '11px', fontWeight: '700', color: colors.textMuted, 
                            textTransform: 'uppercase', letterSpacing: '0.5px',
                            borderBottom: `1px solid ${colors.border}`
                          }}>{header}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredPAPs.map((pap) => (
                        <tr key={pap.id} onClick={() => handleSelectPAP(pap)} 
                          style={{ cursor: 'pointer', borderBottom: `1px solid ${colors.border}`, transition: 'background-color 0.15s' }}
                          onMouseOver={(e) => e.currentTarget.style.backgroundColor = colors.bgLight}
                          onMouseOut={(e) => e.currentTarget.style.backgroundColor = colors.bgCard}>
                          <td style={{ padding: '16px 20px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                              <div style={{ 
                                width: '40px', height: '40px', borderRadius: '10px', 
                                background: `linear-gradient(135deg, ${colors.primary}15 0%, ${colors.primary}25 100%)`,
                                color: colors.primary, 
                                display: 'flex', alignItems: 'center', justifyContent: 'center', 
                                fontSize: '13px', fontWeight: '700' 
                              }}>
                                {pap.household_head_first_name?.[0]}{pap.household_head_surname?.[0]}
                              </div>
                              <span style={{ fontWeight: '600', color: colors.textDark, fontSize: '14px' }}>
                                {pap.household_head_first_name} {pap.household_head_surname}
                              </span>
                            </div>
                          </td>
                          <td style={{ padding: '16px 20px', color: colors.textMuted, fontSize: '14px' }}>{pap.file_number || '-'}</td>
                          <td style={{ padding: '16px 20px', color: colors.textMuted, fontSize: '14px' }}>{pap.land_use || '-'}</td>
                          <td style={{ padding: '16px 20px' }}>
                            {pap.latitude ? (
                              <span style={{ color: colors.success, fontSize: '13px', fontWeight: '600' }}>✓ Yes</span>
                            ) : (
                              <span style={{ color: colors.textLight, fontSize: '13px' }}>-</span>
                            )}
                          </td>
                          <td style={{ padding: '16px 20px' }}>
                            <span style={{ 
                              padding: '5px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: '600',
                              backgroundColor: pap.verification_status?.toLowerCase() === 'verified' ? `${colors.success}20` : `${colors.warning}20`,
                              color: pap.verification_status?.toLowerCase() === 'verified' ? colors.success : colors.warning
                            }}>
                              {pap.verification_status || 'pending'}
                            </span>
                          </td>
                          <td style={{ padding: '16px 20px', textAlign: 'right' }}>
                            <ChevronRight size={20} color={colors.textLight} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {/* PAP DETAIL VIEW */}
          {view === 'detail' && selectedHousehold && (
            <DetailView
              household={selectedHousehold}
              editedData={editedData}
              editMode={editMode}
              isAdmin={isAdmin}
              saving={saving}
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              setEditMode={setEditMode}
              setEditedData={setEditedData}
              onFieldChange={handleFieldChange}
              onSave={handleSave}
              onPhotoUpload={handlePhotoUpload}
              routes={routes}
              onDocumentUpload={handleDocumentUpload}
              onDeleteDocument={handleDeleteDocument}
              onCAFUpload={handleCAFUpload}
              onDeleteCAF={handleDeleteCAF}
              onDeletePAP={handleDeletePAP}
              occupationOptions={occupationOptions}
              onPreviewDoc={setPreviewDoc}
              onRefresh={async () => {
                await loadData()
                const { data: fresh } = await supabase.from('households').select('*').eq('id', selectedHousehold.id).single()
                if (fresh) { setSelectedHousehold(fresh); setEditedData({ ...fresh }) }
              }}
              onPrint={handlePrint}
              colors={colors}
            />
          )}
        </div>
      {/* Add PAP Modal */}
      {showAddPAP && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
          <div style={{ backgroundColor: colors.bgCard, borderRadius: '16px', width: '100%', maxWidth: '700px', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ padding: '20px 24px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', top: 0, backgroundColor: colors.bgCard, zIndex: 1, borderRadius: '16px 16px 0 0' }}>
              <div>
                <h2 style={{ fontSize: '18px', fontWeight: '700', color: colors.textDark, margin: 0 }}>Add New PAP</h2>
                <p style={{ fontSize: '13px', color: colors.textMuted, margin: '4px 0 0 0' }}>{selectedRoute?.name} • {selectedRoute?.type}</p>
              </div>
              <button onClick={() => setShowAddPAP(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '8px' }}><X size={20} color={colors.textMuted} /></button>
            </div>
            <div style={{ padding: '20px 24px' }}>
              <Card title="PAP Information" icon={User} color={colors.primary} colors={colors}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
                  <Field label="First Name *" value={newPAPData.household_head_first_name} field="household_head_first_name" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} />
                  <Field label="Surname *" value={newPAPData.household_head_surname} field="household_head_surname" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} />
                  <Field label="File Number" value={newPAPData.file_number} field="file_number" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} />
                  <Field label="ID Number" value={newPAPData.id_number} field="id_number" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} />
                  <Field label="Phone" value={newPAPData.cellphone_no} field="cellphone_no" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} />
                  <Field label="Gender" value={newPAPData.gender} field="gender" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} options={['Male', 'Female']} />
                  {!showCustomOccupationNew ? (
                    <Field label="Occupation" value={newPAPData.occupation_of_pap} field="occupation_of_pap" editMode={true} onChange={(f, v) => { if (v === 'Other') { setShowCustomOccupationNew(true); setNewPAPData(prev => ({ ...prev, occupation_of_pap: '' })) } else { setNewPAPData(prev => ({ ...prev, [f]: v })) } }} colors={colors} options={occupationOptions} />
                  ) : (
                    <div>
                      <p style={{ fontSize: '12px', color: colors.textMuted, margin: '0 0 6px 0', fontWeight: '500' }}>Occupation (Custom)</p>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <input type="text" value={newPAPData.occupation_of_pap || ''} onChange={(e) => setNewPAPData(prev => ({ ...prev, occupation_of_pap: e.target.value }))} placeholder="Enter occupation" style={{ flex: 1, padding: '10px 14px', border: `2px solid ${colors.accent}`, borderRadius: '8px', fontSize: '14px', outline: 'none', boxSizing: 'border-box', backgroundColor: `${colors.accent}10` }} />
                        <button onClick={() => setShowCustomOccupationNew(false)} style={{ padding: '8px 12px', backgroundColor: colors.bgLight, border: `1px solid ${colors.border}`, borderRadius: '8px', fontSize: '12px', cursor: 'pointer', fontWeight: '600' }}>Back</button>
                      </div>
                    </div>
                  )}
                  <Field label="Community Council" value={newPAPData.community_council} field="community_council" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} />
                  <Field label="Original Village" value={newPAPData.original_village} field="original_village" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} />
                  <Field label="Current Village" value={newPAPData.current_village} field="current_village" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} />
                </div>
              </Card>
              <div style={{ height: '16px' }} />
              <Card title="Location" icon={MapPin} color={colors.accent} colors={colors}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
                  <Field label="Route" value={newPAPData.route_name} colors={colors} />
                  <Field label="Route Type" value={newPAPData.route_type} colors={colors} />
                  <Field label="Land Use" value={newPAPData.land_use} field="land_use" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} />
                  <Field label="GPS Coordinates" value={newPAPData.gps_coordinates} field="gps_coordinates" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} />
                  <Field label="Latitude" value={newPAPData.latitude} field="latitude" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} />
                  <Field label="Longitude" value={newPAPData.longitude} field="longitude" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} />
                </div>
              </Card>
              <div style={{ height: '16px' }} />
              <Card title="Valuation" icon={FileText} color={colors.urban} colors={colors}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
                  <Field label="Permanent Area (sqm)" value={newPAPData.affected_area_perm} field="affected_area_perm" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} />
                  <Field label="Temporary Area (sqm)" value={newPAPData.affected_area_temp} field="affected_area_temp" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} />
                  <Field label="Perm. Rate (M/sqm)" value={newPAPData.rate_perm} field="rate_perm" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} />
                  <Field label="Temp. Rate (M/sqm)" value={newPAPData.rate_temp} field="rate_temp" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} />
                  <Field label="Disturbance Allowance (M)" value={newPAPData.disturbance_allowance} field="disturbance_allowance" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} />
                  <Field label="Total Compensation (M)" value={newPAPData.total_compensation} field="total_compensation" editMode={true} onChange={(f, v) => setNewPAPData(prev => ({ ...prev, [f]: v }))} colors={colors} />
                </div>
              </Card>
            </div>
            <div style={{ padding: '16px 24px', borderTop: `1px solid ${colors.border}`, display: 'flex', gap: '10px', justifyContent: 'flex-end', position: 'sticky', bottom: 0, backgroundColor: colors.bgCard, borderRadius: '0 0 16px 16px' }}>
              <button onClick={() => setShowAddPAP(false)} style={{ padding: '12px 24px', backgroundColor: colors.bgLight, border: `1px solid ${colors.border}`, borderRadius: '10px', color: colors.textDark, fontSize: '14px', fontWeight: '600', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleSaveNewPAP} disabled={savingNewPAP} style={{ padding: '12px 24px', backgroundColor: savingNewPAP ? '#94a3b8' : colors.accent, border: 'none', borderRadius: '10px', color: 'white', fontSize: '14px', fontWeight: '700', cursor: savingNewPAP ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: '8px', boxShadow: '0 2px 8px rgba(140, 198, 63, 0.3)' }}>
                {savingNewPAP ? 'Saving...' : 'Save PAP'}
              </button>
            </div>
          </div>
        </div>
      )}
      </main>

      {/* Document Preview Modal */}
      {previewDoc && (
        <DocumentPreviewModal doc={previewDoc} onClose={() => setPreviewDoc(null)} colors={colors} />
      )}

      {/* Footer */}
      <footer style={{ 
        backgroundColor: colors.bgCard, 
        borderTop: `1px solid ${colors.border}`, 
        padding: '12px 20px', 
        flexShrink: 0 
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
          <img src="/logo-4d.png" alt="4D" style={{ height: '20px', opacity: 0.7 }} onError={(e) => e.target.style.display = 'none'} />
          <span style={{ fontSize: '12px', color: colors.textLight }}>
            Developed by <span style={{ color: colors.accent, fontWeight: '600' }}>4D Climate Solutions</span> for LLWDSP III
          </span>
        </div>
      </footer>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @media (max-width: 768px) { .user-info { display: none !important; } }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: ${colors.bgLight}; }
        ::-webkit-scrollbar-thumb { background: ${colors.border}; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: ${colors.textLight}; }
      `}</style>
    </div>
  )
}

// Progress Stat Component
function ProgressStat({ label, value, total, color }) {
  const percentage = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div style={{ 
      padding: '12px 16px', 
      backgroundColor: colors.bgLight, 
      borderRadius: '10px',
      border: `1px solid ${colors.border}`
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <span style={{ fontSize: '12px', fontWeight: '600', color: colors.textMuted }}>{label}</span>
        <span style={{ fontSize: '14px', fontWeight: '700', color }}>{percentage}%</span>
      </div>
      <div style={{ backgroundColor: colors.border, borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
        <div style={{ width: `${percentage}%`, height: '100%', backgroundColor: color, borderRadius: '4px', transition: 'width 0.3s' }} />
      </div>
      <p style={{ margin: '6px 0 0 0', fontSize: '11px', color: colors.textLight }}>{value} of {total}</p>
    </div>
  )
}

// Route Card Component
function RouteCard({ route, onClick, type, households }) {
  const isRural = type === 'rural'
  const cardColors = isRural 
    ? { bg: '#ecfdf5', border: '#a7f3d0', text: colors.rural, hover: '#dcfce7' }
    : { bg: '#f5f3ff', border: '#c4b5fd', text: colors.urban, hover: '#ede9fe' }
  
  // Calculate route progress
  const routePAPs = households.filter(h => h.route_name === route.name)
  const verifiedCount = routePAPs.filter(h => h.verification_status?.toLowerCase() === 'verified').length
  const progressPercent = routePAPs.length > 0 ? Math.round((verifiedCount / routePAPs.length) * 100) : 0
  
  return (
    <div onClick={onClick} 
      style={{ 
        padding: '18px 20px', 
        backgroundColor: cardColors.bg, 
        border: `1px solid ${cardColors.border}`, 
        borderRadius: '12px', 
        cursor: 'pointer', 
        transition: 'all 0.2s ease'
      }}
      onMouseOver={(e) => { 
        e.currentTarget.style.transform = 'translateY(-2px)' 
        e.currentTarget.style.boxShadow = '0 8px 20px rgba(0,0,0,0.08)'
        e.currentTarget.style.backgroundColor = cardColors.hover
      }}
      onMouseOut={(e) => { 
        e.currentTarget.style.transform = 'none' 
        e.currentTarget.style.boxShadow = 'none'
        e.currentTarget.style.backgroundColor = cardColors.bg
      }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ flex: 1 }}>
          <p style={{ fontWeight: '600', color: colors.textDark, margin: 0, fontSize: '14px' }}>{route.name}</p>
          <p style={{ fontSize: '13px', color: cardColors.text, margin: '4px 0 0 0', fontWeight: '600' }}>{route.pap_count} PAPs</p>
          {/* Mini progress bar */}
          <div style={{ marginTop: '8px', backgroundColor: 'rgba(255,255,255,0.7)', borderRadius: '3px', height: '4px', overflow: 'hidden' }}>
            <div style={{ width: `${progressPercent}%`, height: '100%', backgroundColor: cardColors.text, borderRadius: '3px' }} />
          </div>
          <p style={{ margin: '4px 0 0 0', fontSize: '10px', color: colors.textMuted }}>{verifiedCount} verified ({progressPercent}%)</p>
        </div>
        <div style={{ 
          width: '32px', height: '32px', borderRadius: '8px', 
          backgroundColor: `${cardColors.text}15`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          marginLeft: '12px'
        }}>
          <ChevronRight size={18} color={cardColors.text} />
        </div>
      </div>
    </div>
  )
}

// Stat Card Component
function StatCard({ label, value, color, icon: Icon, iconComponent: IconComponent }) {
  return (
    <div style={{ 
      backgroundColor: colors.bgCard, 
      borderRadius: '14px', 
      padding: '20px 24px', 
      border: `1px solid ${colors.border}`,
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
      transition: 'all 0.2s ease'
    }}
    onMouseOver={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 25px rgba(0,0,0,0.08)' }}
    onMouseOut={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.05)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <p style={{ fontSize: '12px', fontWeight: '600', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px', margin: 0 }}>{label}</p>
          <p style={{ fontSize: '32px', fontWeight: '800', color: colors.textDark, margin: '4px 0 0 0', letterSpacing: '-1px' }}>{value}</p>
        </div>
        <div style={{ 
          padding: '14px', borderRadius: '12px', 
          background: `linear-gradient(135deg, ${color}15 0%, ${color}25 100%)`
        }}>
          {IconComponent ? <IconComponent size={24} color={color} /> : Icon && <Icon size={24} color={color} />}
        </div>
      </div>
    </div>
  )
}

// Detail View Component
function DetailView({ household, editedData, editMode, isAdmin, saving, activeTab, setActiveTab, setEditMode, setEditedData, onFieldChange, onSave, onPhotoUpload, onDocumentUpload, onDeleteDocument, onCAFUpload, onDeleteCAF, onDeletePAP, onRefresh, onPrint, routes, occupationOptions, onPreviewDoc, colors }) {
  const [refreshing, setRefreshing] = useState(false)
  const [showCustomOccupation, setShowCustomOccupation] = useState(false)
  const data = editMode ? editedData : household

  return (
    <div>
      {/* Header */}
      <div style={{ 
        backgroundColor: colors.bgCard, 
        borderRadius: '14px', 
        padding: '20px 24px', 
        marginBottom: '20px', 
        border: `1px solid ${colors.border}`,
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' 
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ 
            width: '56px', height: '56px', borderRadius: '14px', 
            background: `linear-gradient(135deg, ${colors.primary} 0%, ${colors.primaryDark} 100%)`,
            color: 'white', 
            display: 'flex', alignItems: 'center', justifyContent: 'center', 
            fontSize: '20px', fontWeight: '700',
            boxShadow: '0 4px 12px rgba(26, 58, 74, 0.2)'
          }}>
            {household.household_head_first_name?.[0]}{household.household_head_surname?.[0]}
          </div>
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: '700', color: colors.textDark, margin: 0 }}>
              {data.household_head_first_name} {data.household_head_surname}
            </h2>
            <p style={{ fontSize: '14px', color: colors.textMuted, margin: '4px 0 0 0' }}>
              {household.route_name} • {household.land_use || 'N/A'}
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          {!editMode && (
            <button onClick={() => setEditMode(true)} style={{ 
              display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 18px', 
              backgroundColor: colors.warning, color: 'white', 
              border: 'none', borderRadius: '10px', fontSize: '14px', fontWeight: '600', cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(245, 158, 11, 0.3)'
            }}>
              <Edit2 size={16} /> Edit
            </button>
          )}
          {editMode && (
            <>
              <button onClick={onSave} disabled={saving} style={{ 
                display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 18px', 
                backgroundColor: colors.success, color: 'white', 
                border: 'none', borderRadius: '10px', fontSize: '14px', fontWeight: '600', cursor: 'pointer',
                opacity: saving ? 0.7 : 1
              }}>
                <Save size={16} /> {saving ? (isAdmin ? 'Saving...' : 'Submitting...') : (isAdmin ? 'Save' : 'Submit for Approval')}
              </button>
              <button onClick={() => { setEditMode(false); setEditedData({ ...household }) }} style={{ 
                display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 18px', 
                backgroundColor: colors.error, color: 'white', 
                border: 'none', borderRadius: '10px', fontSize: '14px', fontWeight: '600', cursor: 'pointer'
              }}>
                <XCircle size={16} /> Cancel
              </button>
            </>
          )}
          <button onClick={onPrint} style={{ 
            display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 18px', 
            backgroundColor: colors.primary, color: 'white', 
            border: 'none', borderRadius: '10px', fontSize: '14px', fontWeight: '600', cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(26, 58, 74, 0.2)'
          }}>
            <Printer size={16} /> Print
          </button>
          <button onClick={async () => { setRefreshing(true); await onRefresh(); setRefreshing(false) }} disabled={refreshing} style={{ 
            display: 'flex', alignItems: 'center', gap: '6px', padding: '10px', 
            backgroundColor: colors.bgLight, color: colors.textDark, 
            border: `1px solid ${colors.border}`, borderRadius: '10px', fontSize: '14px', fontWeight: '600', cursor: 'pointer',
            opacity: refreshing ? 0.6 : 1
          }} title="Refresh data">
            <RefreshCw size={16} style={{ animation: refreshing ? 'spin 1s linear infinite' : 'none' }} />
          </button>
          {!editMode && (
            <button onClick={() => onDeletePAP(household)} style={{ 
              display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 18px', 
              backgroundColor: colors.error, color: 'white', 
              border: 'none', borderRadius: '10px', fontSize: '14px', fontWeight: '600', cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(239, 68, 68, 0.3)'
            }}>
              <Trash2 size={16} /> {isAdmin ? 'Delete' : 'Request Delete'}
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ 
        display: 'flex', gap: '4px', marginBottom: '20px', 
        backgroundColor: colors.bgCard, padding: '6px', borderRadius: '12px', 
        border: `1px solid ${colors.border}` 
      }}>
        {[
          { id: 'details', label: 'Details', icon: User },
          { id: 'valuation', label: 'Valuation', icon: FileText },
          { id: 'documents', label: 'Documents', icon: FileText },
        ].map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{ 
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', 
            padding: '12px 16px', 
            background: activeTab === tab.id ? `linear-gradient(135deg, ${colors.primary} 0%, ${colors.primaryDark} 100%)` : 'transparent', 
            color: activeTab === tab.id ? 'white' : colors.textMuted, 
            border: 'none', borderRadius: '10px', fontSize: '14px', fontWeight: '600', cursor: 'pointer',
            transition: 'all 0.2s'
          }}>
            <tab.icon size={18} /> {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === 'details' && (
        <div style={{ display: 'grid', gap: '20px' }}>
          <Card title="PAP Information" icon={User} color={colors.primary} colors={colors}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
              <Field label="First Name" value={data.household_head_first_name} field="household_head_first_name" editMode={editMode} onChange={onFieldChange} colors={colors} />
              <Field label="Surname" value={data.household_head_surname} field="household_head_surname" editMode={editMode} onChange={onFieldChange} colors={colors} />
              <Field label="File Number" value={data.file_number} field="file_number" editMode={editMode} onChange={onFieldChange} colors={colors} />
              <Field label="ID Number" value={data.id_number} field="id_number" editMode={editMode} onChange={onFieldChange} colors={colors} />
              <Field label="Phone" value={data.cellphone_no} field="cellphone_no" editMode={editMode} onChange={onFieldChange} colors={colors} />
              <Field label="Gender" value={data.gender} field="gender" editMode={editMode} onChange={onFieldChange} colors={colors} options={['Male', 'Female']} />
              {editMode && !showCustomOccupation ? (
                <Field label="Occupation" value={data.occupation_of_pap} field="occupation_of_pap" editMode={true} onChange={(f, v) => { if (v === 'Other') { setShowCustomOccupation(true); onFieldChange(f, '') } else { onFieldChange(f, v) } }} colors={colors} options={occupationOptions} />
              ) : editMode && showCustomOccupation ? (
                <div>
                  <p style={{ fontSize: '12px', color: colors.textMuted, margin: '0 0 6px 0', fontWeight: '500' }}>Occupation (Custom)</p>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <input type="text" value={data.occupation_of_pap || ''} onChange={(e) => onFieldChange('occupation_of_pap', e.target.value)} placeholder="Enter occupation" style={{ flex: 1, padding: '10px 14px', border: `2px solid ${colors.accent}`, borderRadius: '8px', fontSize: '14px', outline: 'none', boxSizing: 'border-box', backgroundColor: `${colors.accent}10` }} />
                    <button onClick={() => setShowCustomOccupation(false)} style={{ padding: '8px 12px', backgroundColor: colors.bgLight, border: `1px solid ${colors.border}`, borderRadius: '8px', fontSize: '12px', cursor: 'pointer', fontWeight: '600' }}>Back</button>
                  </div>
                </div>
              ) : (
                <Field label="Occupation" value={data.occupation_of_pap} colors={colors} />
              )}
              <Field label="Community Council" value={data.community_council} field="community_council" editMode={editMode} onChange={onFieldChange} colors={colors} />
              <Field label="Original Village" value={data.original_village} field="original_village" editMode={editMode} onChange={onFieldChange} colors={colors} />
              <Field label="Current Village" value={data.current_village} field="current_village" editMode={editMode} onChange={onFieldChange} colors={colors} />
            </div>
          </Card>

          <Card title="Location" icon={MapPin} color={colors.accent} colors={colors}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
              <Field label="Route" value={data.route_name} field="route_name" editMode={editMode} onChange={(f, v) => { onFieldChange(f, v); const r = routes.find(rt => rt.name === v); if (r) onFieldChange('route_type', r.type) }} colors={colors} options={routes.map(r => ({ value: r.name, label: `${r.name} (${r.type})` }))} />
              <Field label="Route Type" value={data.route_type} colors={colors} />
              <Field label="Land Use" value={data.land_use} field="land_use" editMode={editMode} onChange={onFieldChange} colors={colors} options={['Res', 'Agric', 'Com', 'Mixed']} />
              <Field label="GPS Coordinates" value={data.gps_coordinates} field="gps_coordinates" editMode={editMode} onChange={onFieldChange} colors={colors} />
              <Field label="Latitude" value={data.latitude} field="latitude" editMode={editMode} onChange={onFieldChange} colors={colors} />
              <Field label="Longitude" value={data.longitude} field="longitude" editMode={editMode} onChange={onFieldChange} colors={colors} />
            </div>
          </Card>

          {data.banking_details?.length > 0 && (
            <Card title="Banking Details" icon={CreditCard} color={colors.urban} colors={colors}>
              {data.banking_details.map((bank) => (
                <div key={bank.id} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '14px' }}>
                  <Field label="Bank" value={bank.bank_name} colors={colors} />
                  <Field label="Account No." value={bank.account_number} colors={colors} />
                  <Field label="Account Holder" value={bank.account_holder_name} colors={colors} />
                </div>
              ))}
            </Card>
          )}
        </div>
      )}

      {activeTab === 'valuation' && (
        <div style={{ display: 'grid', gap: '20px' }}>
          <Card title="Affected Area & Compensation" icon={Home} color={colors.primary} colors={colors}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
              <Field label="Permanent Area (sqm)" value={data.affected_area_perm} field="affected_area_perm" editMode={editMode} onChange={onFieldChange} colors={colors} />
              <Field label="Temporary Area (sqm)" value={data.affected_area_temp} field="affected_area_temp" editMode={editMode} onChange={onFieldChange} colors={colors} />
              <Field label="Perm. Rate (M/sqm)" value={data.rate_perm} field="rate_perm" editMode={editMode} onChange={onFieldChange} colors={colors} />
              <Field label="Temp. Rate (M/sqm)" value={data.rate_temp} field="rate_temp" editMode={editMode} onChange={onFieldChange} colors={colors} />
              <Field label="Disturbance Allowance (M)" value={data.disturbance_allowance} field="disturbance_allowance" editMode={editMode} onChange={onFieldChange} colors={colors} />
              <Field label="Total Compensation (M)" value={data.total_compensation} field="total_compensation" editMode={editMode} onChange={onFieldChange} highlight colors={colors} />
            </div>
          </Card>

          {data.other_assets_json && (
            <Card title="Other Affected Assets" icon={TreePine} color={colors.rural} colors={colors}>
              <OtherAssets assets={data.other_assets_json} colors={colors} />
            </Card>
          )}
        </div>
      )}

      {activeTab === 'documents' && (
        <div style={{ display: 'grid', gap: '20px' }}>
          <Card title="Compensation Agreement Form (CAF)" icon={FileText} color={colors.primary} colors={colors}>
            <CAFUploader caf={data.caf_document} onUpload={onCAFUpload} onDelete={onDeleteCAF} onPreview={onPreviewDoc} colors={colors} />
          </Card>
          <Card title="PAP Documents" icon={FileUp} color={colors.urban} colors={colors}>
            <DocumentUploader documents={data.other_documents || []} onUpload={onDocumentUpload} onDelete={onDeleteDocument} onPreview={onPreviewDoc} colors={colors} />
          </Card>
        </div>
      )}
    </div>
  )
}

// Card wrapper
function Card({ title, icon: Icon, color, colors, children }) {
  return (
    <div style={{ 
      backgroundColor: colors.bgCard, 
      borderRadius: '14px', 
      padding: '20px 24px', 
      border: `1px solid ${colors.border}`,
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
    }}>
      <h3 style={{ 
        fontSize: '15px', fontWeight: '700', color: color, 
        margin: '0 0 18px 0', display: 'flex', alignItems: 'center', gap: '10px' 
      }}>
        <div style={{ padding: '6px', backgroundColor: `${color}15`, borderRadius: '8px' }}>
          <Icon size={18} />
        </div>
        {title}
      </h3>
      {children}
    </div>
  )
}

// Field component
function Field({ label, value, field, editMode, onChange, highlight, colors, options }) {
  const displayValue = value !== null && value !== undefined ? String(value) : ''
  
  return (
    <div>
      <p style={{ fontSize: '12px', color: colors.textMuted, margin: '0 0 6px 0', fontWeight: '500' }}>{label}</p>
      {editMode && onChange ? (
        options ? (
          <select value={displayValue} onChange={(e) => onChange(field, e.target.value)}
            style={{ width: '100%', padding: '10px 14px', border: `2px solid ${colors.accent}`, borderRadius: '8px', fontSize: '14px', outline: 'none', boxSizing: 'border-box', backgroundColor: `${colors.accent}10`, transition: 'all 0.2s', cursor: 'pointer' }}>
            <option value="">— Select —</option>
            {options.map(opt => {
              const val = typeof opt === 'object' ? opt.value : opt
              const lbl = typeof opt === 'object' ? opt.label : opt
              return <option key={val} value={val}>{lbl}</option>
            })}
          </select>
        ) : (
          <input type="text" value={displayValue} onChange={(e) => onChange(field, e.target.value)} 
            style={{ width: '100%', padding: '10px 14px', border: `2px solid ${colors.accent}`, borderRadius: '8px', fontSize: '14px', outline: 'none', boxSizing: 'border-box', backgroundColor: `${colors.accent}10`, transition: 'all 0.2s' }} />
        )
      ) : (
        <p style={{ fontSize: '14px', fontWeight: highlight ? '700' : '600', color: displayValue ? (highlight ? colors.accent : colors.textDark) : colors.textLight, margin: 0 }}>
          {displayValue || 'N/A'}
        </p>
      )}
    </div>
  )
}

// Other Assets display
function OtherAssets({ assets, colors }) {
  let parsed = []
  try {
    parsed = typeof assets === 'string' ? JSON.parse(assets) : assets
  } catch (e) {
    return <p style={{ color: colors.textMuted, fontSize: '14px' }}>No other assets</p>
  }
  
  if (!parsed || parsed.length === 0) {
    return <p style={{ color: colors.textMuted, fontSize: '14px' }}>No other assets recorded</p>
  }
  
  return (
    <div style={{ display: 'grid', gap: '10px' }}>
      {parsed.map((asset, idx) => (
        <div key={idx} style={{ 
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '12px 16px', backgroundColor: colors.bgLight, borderRadius: '10px', fontSize: '14px' 
        }}>
          <span style={{ fontWeight: '600', color: colors.textDark }}>{asset.type}</span>
          <span style={{ color: colors.textMuted }}>
            Qty: {asset.quantity} | Rate: M{asset.rate} | Value: <span style={{ fontWeight: '600', color: colors.accent }}>M{asset.value}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

// Photo Frame
function PhotoFrame({ label, field, url, onUpload, colors }) {
  const inputRef = useRef(null)
  
  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: '12px', overflow: 'hidden' }}>
      <div style={{ 
        padding: '10px 14px', backgroundColor: colors.bgLight, 
        borderBottom: `1px solid ${colors.border}`, 
        display: 'flex', alignItems: 'center', justifyContent: 'space-between' 
      }}>
        <span style={{ fontSize: '13px', fontWeight: '600', color: colors.textDark }}>{label}</span>
        <button onClick={() => inputRef.current?.click()} style={{ 
          padding: '6px 10px', backgroundColor: colors.warning, 
          border: 'none', borderRadius: '6px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: '4px'
        }}>
          <Edit2 size={12} color="white" />
        </button>
        <input ref={inputRef} type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && onUpload(field, e.target.files[0])} style={{ display: 'none' }} />
      </div>
      <div style={{ 
        height: '140px', display: 'flex', alignItems: 'center', justifyContent: 'center', 
        padding: '12px', backgroundColor: colors.bgLight 
      }}>
        {url ? (
          <img src={url} alt={label} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '8px' }} />
        ) : (
          <div style={{ textAlign: 'center', color: colors.textLight }}>
            <Upload size={28} style={{ opacity: 0.4 }} />
            <p style={{ fontSize: '12px', margin: '8px 0 0 0' }}>Click to upload</p>
          </div>
        )}
      </div>
    </div>
  )
}

// Document Uploader component
function DocumentUploader({ documents, onUpload, onDelete, onPreview, colors }) {
  const [queue, setQueue] = useState([])
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef(null)
  const folderRef = useRef(null)

  const addFiles = (files) => {
    const newItems = Array.from(files).filter(f => f.size > 0).map(f => ({
      file: f,
      name: f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') || f.name : f.name,
      done: false,
      error: null,
      uploading: false
    }))
    setQueue(prev => [...prev, ...newItems])
  }

  const removeFromQueue = (index) => setQueue(prev => prev.filter((_, i) => i !== index))

  const handleUploadAll = async () => {
    const toUpload = queue.filter(q => !q.done)
    if (toUpload.length === 0) return
    setUploading(true)
    let successCount = 0
    const updated = [...queue]
    for (let i = 0; i < updated.length; i++) {
      if (updated[i].done) continue
      updated[i] = { ...updated[i], uploading: true }
      setQueue([...updated])
      try {
        await onUpload(updated[i].file, updated[i].name)
        updated[i] = { ...updated[i], uploading: false, done: true }
        successCount++
      } catch (err) {
        updated[i] = { ...updated[i], uploading: false, error: err.message }
      }
      setQueue([...updated])
    }
    setUploading(false)
    if (successCount > 0) {
      alert(`✅ ${successCount} document${successCount > 1 ? 's' : ''} uploaded!`)
      setQueue([])
    }
  }

  const btnStyle = (bg) => ({ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '10px 16px', backgroundColor: bg, border: 'none', borderRadius: '8px', color: 'white', fontSize: '13px', fontWeight: '700', cursor: 'pointer', flex: 1 })

  return (
    <div>
      {/* Existing documents */}
      {documents.length > 0 ? (
        <div style={{ display: 'grid', gap: '10px', marginBottom: '16px', maxHeight: '400px', overflowY: 'auto' }}>
          {documents.map((doc, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', backgroundColor: colors.bgLight, borderRadius: '10px', border: `1px solid ${colors.border}` }}>
              <div style={{ width: '40px', height: '40px', borderRadius: '8px', backgroundColor: `${colors.urban}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><FileText size={20} color={colors.urban} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: '14px', fontWeight: '600', color: colors.textDark, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{doc.name}</p>
                <p style={{ fontSize: '12px', color: colors.textMuted, margin: '2px 0 0 0' }}>{doc.file_type?.toUpperCase() || 'PDF'} • {new Date(doc.uploaded_at).toLocaleDateString()}</p>
              </div>
              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                <button onClick={() => onPreview?.(doc)} style={{ width: '34px', height: '34px', borderRadius: '8px', backgroundColor: `${colors.accent}15`, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}><Eye size={16} color={colors.accent} /></button>
                <a href={doc.url} download style={{ width: '34px', height: '34px', borderRadius: '8px', backgroundColor: `${colors.primary}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}><Download size={16} color={colors.primary} /></a>
                <button onClick={() => onDelete(i)} style={{ width: '34px', height: '34px', borderRadius: '8px', backgroundColor: '#fee2e2', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}><Trash2 size={16} color="#ef4444" /></button>
              </div>
            </div>
          ))}
        </div>
      ) : queue.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '24px', color: colors.textLight, marginBottom: '16px' }}>
          <FileUp size={32} style={{ opacity: 0.3, marginBottom: '8px' }} />
          <p style={{ fontSize: '13px', margin: 0 }}>No documents uploaded yet</p>
        </div>
      ) : null}

      {/* Upload queue */}
      {queue.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <span style={{ fontSize: '13px', fontWeight: '700', color: colors.textDark }}>{queue.filter(q => !q.done).length} file{queue.filter(q => !q.done).length !== 1 ? 's' : ''} ready to upload</span>
            {!uploading && <button onClick={() => setQueue([])} style={{ fontSize: '12px', color: colors.error, background: 'none', border: 'none', cursor: 'pointer', fontWeight: '600' }}>Clear all</button>}
          </div>
          <div style={{ display: 'grid', gap: '6px', maxHeight: '200px', overflowY: 'auto' }}>
            {queue.map((item, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', borderRadius: '8px', backgroundColor: item.done ? `${colors.accent}08` : item.error ? '#fef2f2' : colors.bgLight, border: `1px solid ${item.done ? colors.accent : item.error ? '#fecaca' : colors.border}`, fontSize: '13px' }}>
                {item.uploading ? (
                  <div style={{ width: '16px', height: '16px', border: '2px solid #e2e8f0', borderTopColor: colors.accent, borderRadius: '50%', animation: 'spin 1s linear infinite', flexShrink: 0 }} />
                ) : item.done ? (
                  <Check size={16} color={colors.accent} style={{ flexShrink: 0 }} />
                ) : (
                  <FileText size={16} color={colors.textMuted} style={{ flexShrink: 0 }} />
                )}
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: item.done ? colors.accent : colors.textDark, fontWeight: item.done ? '600' : '400' }}>{item.name}</span>
                <span style={{ fontSize: '11px', color: colors.textMuted, flexShrink: 0 }}>{(item.file.size / 1024).toFixed(0)} KB</span>
                {!item.done && !item.uploading && (
                  <button onClick={() => removeFromQueue(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', flexShrink: 0 }}><X size={14} color={colors.textMuted} /></button>
                )}
              </div>
            ))}
          </div>
          <button onClick={handleUploadAll} disabled={uploading} style={{ ...btnStyle(uploading ? '#94a3b8' : colors.accent), marginTop: '10px', width: '100%', padding: '12px' }}>
            {uploading ? 'Uploading...' : `Upload ${queue.filter(q => !q.done).length} File${queue.filter(q => !q.done).length !== 1 ? 's' : ''}`}
          </button>
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: '10px' }}>
        <input ref={fileRef} type="file" multiple onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} style={{ display: 'none' }} />
        <input ref={folderRef} type="file" webkitdirectory="" directory="" multiple onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} style={{ display: 'none' }} />
        <button onClick={() => fileRef.current?.click()} style={btnStyle(colors.urban)}>
          <Upload size={16} /> Add Files
        </button>
        <button onClick={() => folderRef.current?.click()} style={btnStyle(colors.primary)}>
          <FileUp size={16} /> Add Folder
        </button>
      </div>
    </div>
  )
}

// CAF Uploader component
function CAFUploader({ caf, onUpload, onDelete, onPreview, colors }) {
  const inputRef = useRef(null)
  return (
    <div>
      {caf ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 18px', backgroundColor: colors.bgLight, borderRadius: '10px', border: `1px solid ${colors.border}` }}>
          <div style={{ width: '44px', height: '44px', borderRadius: '10px', backgroundColor: `${colors.primary}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><FileText size={22} color={colors.primary} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: '14px', fontWeight: '600', color: colors.textDark, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{caf.name}</p>
            <p style={{ fontSize: '12px', color: colors.textMuted, margin: '2px 0 0 0' }}>{caf.file_type?.toUpperCase() || 'PDF'} • {new Date(caf.uploaded_at).toLocaleDateString()}</p>
          </div>
          <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
            <button onClick={() => onPreview?.(caf)} style={{ padding: '8px 14px', backgroundColor: `${colors.accent}15`, border: 'none', borderRadius: '8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', fontWeight: '600', color: colors.accent }}><Eye size={14} /> View</button>
            <a href={caf.url} download style={{ padding: '8px 14px', backgroundColor: `${colors.primary}15`, borderRadius: '8px', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', fontWeight: '600', color: colors.primary }}><Download size={14} /> Download</a>
            <button onClick={() => inputRef.current?.click()} style={{ padding: '8px 14px', backgroundColor: `${colors.warning}15`, border: 'none', borderRadius: '8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', fontWeight: '600', color: colors.warning }}><Upload size={14} /> Replace</button>
            <button onClick={onDelete} style={{ padding: '8px 14px', backgroundColor: '#fee2e2', border: 'none', borderRadius: '8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', fontWeight: '600', color: '#ef4444' }}><Trash2 size={14} /> Delete</button>
          </div>
          <input ref={inputRef} type="file" onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} style={{ display: 'none' }} />
        </div>
      ) : (
        <div style={{ textAlign: 'center', padding: '30px 20px', border: `2px dashed ${colors.border}`, borderRadius: '12px', cursor: 'pointer' }} onClick={() => inputRef.current?.click()}>
          <Upload size={32} color={colors.textLight} style={{ opacity: 0.4, marginBottom: '8px' }} />
          <p style={{ fontSize: '14px', color: colors.textMuted, margin: '0 0 4px 0', fontWeight: '600' }}>Upload Compensation Agreement Form</p>
          <p style={{ fontSize: '12px', color: colors.textLight, margin: 0 }}>Click to select a file (PDF, image, or document)</p>
          <input ref={inputRef} type="file" onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} style={{ display: 'none' }} />
        </div>
      )}
    </div>
  )
}

// Document Preview Modal
function DocumentPreviewModal({ doc, onClose, colors }) {
  const ext = (doc.file_type || doc.name?.split('.').pop() || '').toLowerCase()
  const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)
  const isPdf = ext === 'pdf'
  return (
    <div onClick={onClose} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ backgroundColor: colors.bgCard, borderRadius: '16px', width: '90%', maxWidth: '900px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <p style={{ fontSize: '15px', fontWeight: '700', color: colors.textDark, margin: 0 }}>{doc.name}</p>
            <p style={{ fontSize: '12px', color: colors.textMuted, margin: '2px 0 0 0' }}>{ext.toUpperCase()} • {doc.uploaded_at ? new Date(doc.uploaded_at).toLocaleDateString() : ''}</p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <a href={doc.url} download style={{ padding: '8px 14px', backgroundColor: colors.accent, borderRadius: '8px', textDecoration: 'none', color: 'white', fontSize: '13px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px' }}><Download size={14} /> Download</a>
            <button onClick={onClose} style={{ padding: '8px', backgroundColor: colors.bgLight, border: 'none', borderRadius: '8px', cursor: 'pointer' }}><X size={18} color={colors.textMuted} /></button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', minHeight: '400px' }}>
          {isPdf ? (
            <iframe src={doc.url} style={{ width: '100%', height: '70vh', border: 'none', borderRadius: '8px' }} />
          ) : isImage ? (
            <img src={doc.url} alt={doc.name} style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain', borderRadius: '8px' }} />
          ) : (
            <div style={{ textAlign: 'center', color: colors.textMuted }}>
              <FileText size={48} style={{ opacity: 0.3, marginBottom: '12px' }} />
              <p style={{ fontSize: '14px', margin: '0 0 8px 0' }}>Preview not available for this file type</p>
              <a href={doc.url} download style={{ padding: '10px 20px', backgroundColor: colors.accent, borderRadius: '8px', textDecoration: 'none', color: 'white', fontSize: '13px', fontWeight: '600' }}>Download File</a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Print HTML Generator
function generatePrintHTML(data) {
  const otherAssets = data.other_assets_json ? (typeof data.other_assets_json === 'string' ? JSON.parse(data.other_assets_json) : data.other_assets_json) : []
  const assetsHtml = otherAssets.map(a => `<tr><td style="padding:6px 10px;border:1px solid #e2e8f0">${a.type}</td><td style="padding:6px 10px;border:1px solid #e2e8f0;text-align:center">${a.quantity}</td><td style="padding:6px 10px;border:1px solid #e2e8f0;text-align:right">M ${a.value}</td></tr>`).join('')
  
  return `<!DOCTYPE html><html><head><title>CIMS - ${data.household_head_first_name} ${data.household_head_surname}</title>
<style>
@page{size:A4;margin:12mm}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:10pt;color:#1f2937;margin:0;padding:0}
.page{padding:8mm}
.header{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #1a3a4a;padding-bottom:12px;margin-bottom:16px}
.header img{height:40px}
.title{text-align:center;margin-bottom:18px}
.title h1{font-size:18pt;color:#1a3a4a;margin:0;font-weight:700}
.title p{margin:4px 0 0 0;color:#6b7280}
.section{margin-bottom:14px}
.section-title{font-size:11pt;font-weight:700;color:#1a3a4a;border-bottom:2px solid #8cc63f;padding-bottom:4px;margin-bottom:10px}
table{width:100%;border-collapse:collapse;font-size:9pt}
td{padding:6px 10px;border:1px solid #e2e8f0}
.label{background:#f8fafc;font-weight:600;width:35%;color:#1a3a4a}
.page-break{page-break-after:always}
.photo-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.photo-box{border:1px solid #e2e8f0;border-radius:8px;overflow:hidden}
.photo-box-title{padding:8px 12px;background:#f8fafc;font-weight:600;font-size:9pt;border-bottom:1px solid #e2e8f0;color:#1a3a4a}
.photo-box-content{height:120px;display:flex;align-items:center;justify-content:center;background:#f8fafc}
.photo-box-content img{max-width:100%;max-height:100%;object-fit:contain}
.signature{margin-top:24px;display:flex;gap:30px}
.signature>div{flex:1}
.sig-line{border-bottom:1px solid #1a3a4a;height:35px;margin-bottom:4px}
</style></head><body>
<div class="page">
<div class="header">
<img src="/logo-lesotho.png" onerror="this.style.display='none'">
<img src="/logo-llwdp.png" onerror="this.style.display='none'">
<img src="/logo-afdb.png" onerror="this.style.display='none'">
<img src="/logo-4d.png" onerror="this.style.display='none'">
</div>
<div class="title"><h1>Asset Verification Form</h1><p>Foromo E Netefatso Ea Thepa • ${data.route_name || ''}</p></div>

<div class="section">
<div class="section-title">PAP Information / Tlhahisoleseling Ea Mong'a Thepa</div>
<table>
<tr><td class="label">Name / Lebitso</td><td>${data.household_head_first_name || ''} ${data.household_head_surname || ''}</td><td class="label">File No.</td><td>${data.file_number || '-'}</td></tr>
<tr><td class="label">ID Number / Nomoro Ea ID</td><td>${data.id_number || '-'}</td><td class="label">Phone / Mohala</td><td>${data.cellphone_no || '-'}</td></tr>
<tr><td class="label">Route</td><td>${data.route_name || '-'}</td><td class="label">Land Use</td><td>${data.land_use || '-'}</td></tr>
<tr><td class="label">Original Village</td><td>${data.original_village || '-'}</td><td class="label">Current Village</td><td>${data.current_village || '-'}</td></tr>
<tr><td class="label">GPS</td><td colspan="3">${data.gps_coordinates || '-'}</td></tr>
</table>
</div>

<div class="section">
<div class="section-title">Valuation / Tlhahlobo Ea Boleng</div>
<table>
<tr><td class="label">Permanent Area (sqm)</td><td>${data.affected_area_perm || '-'}</td><td class="label">Temporary Area (sqm)</td><td>${data.affected_area_temp || '-'}</td></tr>
<tr><td class="label">Disturbance Allowance</td><td>M ${data.disturbance_allowance || '-'}</td><td class="label">Total Compensation</td><td style="font-weight:700;color:#8cc63f">M ${data.total_compensation || '-'}</td></tr>
</table>
</div>

${otherAssets.length > 0 ? `
<div class="section">
<div class="section-title">Other Assets / Thepa E Nngoe</div>
<table><tr><th style="padding:6px 10px;border:1px solid #e2e8f0;background:#f8fafc;text-align:left;font-weight:600">Asset Type</th><th style="padding:6px 10px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600">Qty</th><th style="padding:6px 10px;border:1px solid #e2e8f0;background:#f8fafc;text-align:right;font-weight:600">Value</th></tr>${assetsHtml}</table>
</div>` : ''}
</div>

<div class="page-break"></div>

<div class="page">
<div class="header">
<img src="/logo-lesotho.png" style="height:35px" onerror="this.style.display='none'">
<div style="text-align:center"><strong style="color:#1a3a4a;font-size:12pt">Documents & Photos</strong><br><span style="font-size:9pt;color:#6b7280">${data.household_head_first_name || ''} ${data.household_head_surname || ''}</span></div>
<img src="/logo-4d.png" style="height:30px" onerror="this.style.display='none'">
</div>

<div class="photo-grid">
<div class="photo-box"><div class="photo-box-title">PAP Photograph</div><div class="photo-box-content">${data.photograph_of_pap_url ? `<img src="${data.photograph_of_pap_url}">` : '<span style="color:#9ca3af">No photo</span>'}</div></div>
<div class="photo-box"><div class="photo-box-title">ID Document</div><div class="photo-box-content">${data.id_document_url ? `<img src="${data.id_document_url}">` : '<span style="color:#9ca3af">No document</span>'}</div></div>
<div class="photo-box"><div class="photo-box-title">Asset Photo</div><div class="photo-box-content">${data.asset_photo_url ? `<img src="${data.asset_photo_url}">` : '<span style="color:#9ca3af">No photo</span>'}</div></div>
<div class="photo-box"><div class="photo-box-title">Location Map</div><div class="photo-box-content">${data.map_url ? `<img src="${data.map_url}">` : '<span style="color:#9ca3af">No map</span>'}</div></div>
</div>

<div class="signature">
<div><p style="font-size:9pt;color:#6b7280;margin:0 0 6px">PAP Signature / Tekeno Ea Mong'a Thepa:</p><div class="sig-line"></div></div>
<div><p style="font-size:9pt;color:#6b7280;margin:0 0 6px">Verified By / Netefalitsoe Ke:</p><div class="sig-line"></div></div>
<div><p style="font-size:9pt;color:#6b7280;margin:0 0 6px">Date / Letsatsi:</p><div class="sig-line"></div></div>
</div>

<div style="margin-top:20px;text-align:center;padding-top:12px;border-top:1px solid #e2e8f0">
<p style="font-size:8pt;color:#9ca3af;margin:0">LLWDSP III - Lesotho Lowlands Water Supply & Sanitation Project Phase III</p>
<p style="font-size:8pt;color:#8cc63f;margin:4px 0 0 0;font-weight:600">4D Climate Solutions</p>
</div>
</div>
</body></html>`
}
